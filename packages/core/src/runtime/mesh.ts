import { randomUUID } from "node:crypto";
import { EventBus, type ObservationEvent, type WAL, FileWAL, MemoryWAL } from "../events/index.js";
import { ObserverRegistry, type Observer } from "../observers/index.js";
import { OperatorRegistry, type Operator, type OperatorContext, type OperatorResult } from "../operators/index.js";
import { GoalEngine, type Goal, type RetryPolicy } from "../coordinators/index.js";
import { StateStore } from "../state/index.js";

// ── Mesh Configuration ──────────────────────────────────────────────

export interface MeshConfig {
  /** Directory for WAL and state persistence */
  dataDir?: string;
  /** Default step timeout in ms */
  defaultStepTimeoutMs?: number;
  /** Log level */
  logLevel?: "debug" | "info" | "warn" | "error";
  /** Handler for human approval requests */
  approvalHandler?: (description: string, goalId: string, stepLabel: string) => Promise<boolean>;
}

export type MeshLogger = (level: string, component: string, message: string, ...args: unknown[]) => void;

// ── Mesh Runtime ────────────────────────────────────────────────────

/**
 * The Mesh runtime: boots observers, wires events to the GoalEngine,
 * executes goal steps through operators, persists state.
 *
 * This is the central process of OpenMesh.
 */
export class Mesh {
  readonly bus: EventBus;
  readonly observers: ObserverRegistry;
  readonly operators: OperatorRegistry;
  readonly goals: GoalEngine;
  readonly state: StateStore;
  readonly config: Required<MeshConfig>;
  private running = false;
  private shutdownController = new AbortController();
  private log: MeshLogger;

  constructor(config?: MeshConfig) {
    const dataDir = config?.dataDir ?? ".openmesh";
    this.config = {
      dataDir,
      defaultStepTimeoutMs: config?.defaultStepTimeoutMs ?? 300_000,
      logLevel: config?.logLevel ?? "info",
      approvalHandler: config?.approvalHandler ?? (async () => true),
    };

    const wal: WAL = dataDir ? new FileWAL(`${dataDir}/events.wal.jsonl`) : new MemoryWAL();
    this.bus = new EventBus(wal);
    this.observers = new ObserverRegistry();
    this.operators = new OperatorRegistry();
    this.goals = new GoalEngine();
    this.state = new StateStore(dataDir ? `${dataDir}/state.jsonl` : undefined);

    this.log = (_level, component, message, ...args) => {
      const ts = new Date().toISOString().slice(11, 23);
      console.log(`${ts} [${component}] ${message}`, ...args);
    };

    // Wire the event→goal→operator pipeline (always active, not just after start)
    this.bus.on("**", async (event) => {
      await this.handleEvent(event);
    });
  }

  /** Register an observer */
  addObserver(observer: Observer): this {
    this.observers.register(observer);
    return this;
  }

  /** Register an operator */
  addOperator(operator: Operator): this {
    this.operators.register(operator);
    return this;
  }

  /** Register a goal */
  addGoal(goal: Goal): this {
    this.goals.register(goal);
    return this;
  }

  /** Start the mesh: boot observers, wire event→goal→operator pipeline */
  async start(): Promise<void> {
    if (this.running) throw new Error("Mesh is already running");
    this.running = true;
    this.shutdownController = new AbortController();

    this.log("info", "mesh", `Starting OpenMesh...`);
    this.log("info", "mesh", `  Observers: ${this.observers.list().map(o => o.id).join(", ") || "(none)"}`);
    this.log("info", "mesh", `  Operators: ${this.operators.list().map(o => o.id).join(", ") || "(none)"}`);
    this.log("info", "mesh", `  Goals: ${this.goals.list().map(g => g.id).join(", ") || "(none)"}`);

    // Start all observers
    await this.observers.startAll(this.bus);
    this.log("info", "mesh", "Mesh is running. Waiting for events...");
  }

  /** Stop the mesh gracefully */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.log("info", "mesh", "Shutting down...");
    this.shutdownController.abort();
    await this.observers.stopAll();
    this.bus.clear();
    this.running = false;
    this.log("info", "mesh", "Mesh stopped.");
  }

  /** Manually inject an event (for testing or external triggers) */
  async inject(event: ObservationEvent): Promise<void> {
    await this.bus.emit(event);
  }

  /** Create a standard event with auto-generated id and timestamp */
  createEvent(type: string, source: string, payload: Record<string, unknown>, dedupKey?: string): ObservationEvent {
    return {
      id: randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      source,
      payload,
      dedupKey,
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Internal: Event → Goal → Operator Pipeline ────────────────────

  private async handleEvent(event: ObservationEvent): Promise<void> {
    this.state.append({ kind: "observation", event });

    const matched = this.goals.matchEvent(event);
    if (matched.length === 0) return;

    for (const goal of matched) {
      this.log("info", "goal", `"${goal.id}" matched event ${event.type}`);
      this.goals.setState(goal.id, { phase: "matched", event, matchedAt: new Date().toISOString() });
      this.state.append({ kind: "goal_matched", goalId: goal.id, event });

      await this.executeGoal(goal, event);
    }
  }

  private async executeGoal(goal: Goal, event: ObservationEvent): Promise<void> {
    const stepResults = new Map<string, OperatorResult>();

    for (let stepIdx = 0; stepIdx < goal.then.length; stepIdx++) {
      const step = goal.then[stepIdx]!;

      // Evaluate "when" condition
      if (step.when && !this.evaluateCondition(step.when, stepResults)) {
        this.log("debug", "goal", `  Step "${step.label}" skipped (condition: ${step.when})`);
        continue;
      }

      this.goals.setState(goal.id, {
        phase: "executing",
        event,
        currentStep: stepIdx,
        stepResults,
      });

      this.log("info", "goal", `  Executing step "${step.label}" → operator "${step.operator}"`);
      this.state.append({ kind: "step_started", goalId: goal.id, stepLabel: step.label });

      // Interpolate task template
      const task = this.interpolateTemplate(step.task, event, stepResults);

      // Build operator context
      const timeoutMs = step.timeoutMs ?? this.config.defaultStepTimeoutMs;
      const stepController = new AbortController();
      const timer = setTimeout(() => stepController.abort(), timeoutMs);

      const ctx: OperatorContext = {
        task,
        event: event.payload,
        signal: stepController.signal,
        log: (msg, ...args) => this.log("info", `op:${step.operator}`, msg, ...args),
        requestApproval: async (description) => {
          this.goals.setState(goal.id, { phase: "waiting-human", event, pendingApproval: description });
          this.state.append({ kind: "approval_requested", goalId: goal.id, stepLabel: step.label });
          const approved = await this.config.approvalHandler(description, goal.id, step.label);
          this.state.append({ kind: "approval_resolved", goalId: goal.id, stepLabel: step.label });
          return approved;
        },
      };

      const result = await this.executeStepWithRetry(step.operator, ctx, step.retry);
      clearTimeout(timer);

      stepResults.set(step.label, result);
      this.state.append({
        kind: "step_completed",
        goalId: goal.id,
        stepLabel: step.label,
        result,
      });

      this.log("info", "goal", `  Step "${step.label}" → ${result.status}: ${result.summary}`);

      // If step failed and there's an escalation policy, check
      if (result.status === "failure" && goal.escalate) {
        const failures = this.countRecentFailures(goal.id);
        if (failures >= goal.escalate.afterFailures) {
          this.log("warn", "goal", `  Escalating "${goal.id}" after ${failures} failures`);
          // Auto-escalate via comms operator if available
          await this.escalate(goal, event, stepResults);
        }
      }
    }

    // Mark goal as completed
    this.goals.setState(goal.id, { phase: "completed", event, stepResults });
    this.state.append({
      kind: "goal_completed",
      goalId: goal.id,
    });
    this.log("info", "goal", `Goal "${goal.id}" completed.`);
  }

  /** Interpolate {{event.*}} and {{steps.<label>.*}} templates */
  private interpolateTemplate(
    template: string,
    event: ObservationEvent,
    stepResults: Map<string, OperatorResult>,
  ): string {
    return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, path: string) => {
      const parts = path.split(".");
      if (parts[0] === "event") {
        let val: unknown = event;
        for (const p of parts.slice(1)) {
          if (val && typeof val === "object" && p in val) {
            val = (val as Record<string, unknown>)[p];
          } else {
            return `{{${path}}}`;
          }
        }
        return String(val);
      }
      if (parts[0] === "steps" && parts.length >= 3) {
        const stepLabel = parts[1]!;
        const field = parts.slice(2).join(".");
        const result = stepResults.get(stepLabel);
        if (!result) return `{{${path}}}`;
        if (field === "summary") return result.summary;
        if (field === "status") return result.status;
        if (field.startsWith("data.") && result.data) {
          const dataKey = field.slice(5);
          return String(result.data[dataKey] ?? `{{${path}}}`);
        }
        return `{{${path}}}`;
      }
      return `{{${path}}}`;
    });
  }

  /** Evaluate simple conditions like "investigate.status == 'success'" */
  private evaluateCondition(
    condition: string,
    stepResults: Map<string, OperatorResult>,
  ): boolean {
    // Parse: "stepLabel.field op 'value'"
    const match = /^(\w+)\.(\w+)\s*(==|!=)\s*'([^']*)'$/.exec(condition.trim());
    if (!match) return true; // Unknown condition format → proceed

    const [, stepLabel, field, op, value] = match;
    const result = stepResults.get(stepLabel!);
    if (!result) return false;

    const actual = field === "status" ? result.status : result.summary;
    if (op === "==") return actual === value;
    if (op === "!=") return actual !== value;
    return true;
  }

  private countRecentFailures(goalId: string): number {
    const checkpoints = this.state.query({ goalId, kind: "step_completed" });
    let count = 0;
    // Count consecutive failures from the end
    for (let i = checkpoints.length - 1; i >= 0; i--) {
      if (checkpoints[i]!.result?.status === "failure") count++;
      else break;
    }
    return count;
  }

  private async escalate(
    goal: Goal,
    event: ObservationEvent,
    _stepResults: Map<string, OperatorResult>,
  ): Promise<void> {
    if (!goal.escalate) return;
    const esc = goal.escalate;

    const ctx: OperatorContext = {
      task: `ESCALATION: Goal "${goal.id}" has failed ${esc.afterFailures}+ times. Notify ${esc.to} on ${esc.channel}.`,
      event: event.payload,
      signal: new AbortController().signal,
      log: (msg) => this.log("warn", "escalation", msg),
      requestApproval: async () => true,
    };

    await this.operators.execute("comms", ctx);
  }

  /** Execute a step with retry/backoff policy */
  private async executeStepWithRetry(
    operatorId: string,
    ctx: OperatorContext,
    retry?: RetryPolicy,
  ): Promise<OperatorResult> {
    const maxRetries = retry?.maxRetries ?? 0;
    const baseDelay = retry?.delayMs ?? 1000;
    const multiplier = retry?.backoffMultiplier ?? 2.0;
    const maxDelay = retry?.maxDelayMs ?? 60_000;

    let lastResult = await this.operators.execute(operatorId, ctx);
    if (lastResult.status === "success" || maxRetries <= 0) {
      return lastResult;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const delay = Math.min(baseDelay * multiplier ** (attempt - 1), maxDelay);
      this.log("info", "retry", `  Retry ${attempt}/${maxRetries} for "${operatorId}" in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));

      if (ctx.signal.aborted) return lastResult;

      lastResult = await this.operators.execute(operatorId, ctx);
      if (lastResult.status === "success") break;
    }

    return lastResult;
  }
}
