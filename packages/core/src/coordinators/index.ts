import type { ObservationEvent, EventPattern } from "../events/index.js";
import type { OperatorResult } from "../operators/index.js";

// ── Goal Types ──────────────────────────────────────────────────────

/** Retry policy for a step or goal */
export interface RetryPolicy {
  /** Maximum number of retries (default: 0 — no retry) */
  maxRetries: number;
  /** Initial delay between retries in ms (default: 1000) */
  delayMs?: number;
  /** Backoff multiplier (default: 2.0 — exponential) */
  backoffMultiplier?: number;
  /** Maximum delay cap in ms (default: 60000) */
  maxDelayMs?: number;
}

/** A step in a goal's response plan */
export interface GoalStep {
  /** Step label for display and status tracking */
  label: string;
  /** Operator to invoke */
  operator: string;
  /** Task template — supports {{event.*}} and {{steps.<label>.*}} interpolation */
  task: string;
  /** Timeout for this step */
  timeoutMs?: number;
  /** Condition to evaluate before running (references prior step results) */
  when?: string;
  /** Retry policy for this step */
  retry?: RetryPolicy;
  /** Channel + target for comms operators */
  channel?: string;
  to?: string;
}

/** Escalation policy when goal execution fails */
export interface EscalationPolicy {
  /** Escalate after N consecutive failures */
  afterFailures: number;
  /** Channel to escalate to */
  channel: string;
  /** Target (e.g., "#oncall") */
  to: string;
}

/** Goal definition — a declared operational intent */
export interface Goal {
  /** Unique goal ID */
  id: string;
  /** Human-readable description */
  description: string;
  /** Event patterns to observe */
  observe: EventPattern[];
  /** Steps to execute when observation matches */
  then: GoalStep[];
  /** Escalation policy */
  escalate?: EscalationPolicy;
  /** Deduplication window in ms — don't re-trigger for same dedupKey within window */
  dedupWindowMs?: number;
}

// ── Goal Execution State ────────────────────────────────────────────

export type GoalState =
  | { phase: "idle" }
  | { phase: "matched"; event: ObservationEvent; matchedAt: string }
  | {
      phase: "executing";
      event: ObservationEvent;
      currentStep: number;
      stepResults: Map<string, OperatorResult>;
    }
  | { phase: "waiting-human"; event: ObservationEvent; pendingApproval: string }
  | {
      phase: "completed";
      event: ObservationEvent;
      stepResults: Map<string, OperatorResult>;
    }
  | { phase: "failed"; event: ObservationEvent; error: string };

// ── Goal Engine ─────────────────────────────────────────────────────

/**
 * Evaluates observation events against registered goals,
 * executes matching goal steps via operators, and tracks state.
 */
export class GoalEngine {
  private goals = new Map<string, Goal>();
  private states = new Map<string, GoalState>();
  private dedup = new Map<string, number>(); // dedupKey → timestamp

  register(goal: Goal): void {
    if (this.goals.has(goal.id)) {
      throw new Error(`Goal already registered: ${goal.id}`);
    }
    this.goals.set(goal.id, goal);
    this.states.set(goal.id, { phase: "idle" });
  }

  /** Check if an event matches any registered goal */
  matchEvent(event: ObservationEvent): Goal[] {
    const matched: Goal[] = [];

    for (const [, goal] of this.goals) {
      for (const pattern of goal.observe) {
        if (matchEventPattern(pattern, event)) {
          // Check dedup window
          if (goal.dedupWindowMs && event.dedupKey) {
            const lastSeen = this.dedup.get(
              `${goal.id}:${event.dedupKey}`,
            );
            if (
              lastSeen &&
              Date.now() - lastSeen < goal.dedupWindowMs
            ) {
              continue;
            }
            this.dedup.set(`${goal.id}:${event.dedupKey}`, Date.now());
          }
          matched.push(goal);
          break;
        }
      }
    }

    return matched;
  }

  getState(goalId: string): GoalState | undefined {
    return this.states.get(goalId);
  }

  setState(goalId: string, state: GoalState): void {
    this.states.set(goalId, state);
  }

  get(id: string): Goal | undefined {
    return this.goals.get(id);
  }

  list(): Goal[] {
    return [...this.goals.values()];
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function matchEventPattern(
  pattern: EventPattern,
  event: ObservationEvent,
): boolean {
  // Match event type with glob
  const typeRegex = pattern.type
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^.]*")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");

  if (!new RegExp(`^${typeRegex}$`).test(event.type)) {
    return false;
  }

  // Match where clauses against payload
  if (pattern.where) {
    for (const [key, expected] of Object.entries(pattern.where)) {
      const actual = (event.payload as Record<string, unknown>)[key];
      if (actual !== expected) {
        return false;
      }
    }
  }

  return true;
}
