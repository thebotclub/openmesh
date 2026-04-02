import type { Goal } from "@openmesh/core";
import { AIEngine } from "./engine.js";
import { GoalInterpreter, type InterpretedGoal } from "./goalInterpreter.js";

export interface RefineSessionConfig {
  model?: string;
  ragContext?: string;
}

/**
 * RefineSession — manages a multi-turn goal refinement conversation.
 *
 * The session keeps track of the current goal state and allows
 * iterative refinement through natural language feedback.
 */
export class RefineSession {
  private ai: AIEngine;
  private interpreter: GoalInterpreter;
  private history: Array<{ role: "user" | "assistant"; content: string }> = [];
  private currentGoal: Goal | null = null;
  private ragContext?: string;

  constructor(config?: RefineSessionConfig) {
    this.ai = new AIEngine(config?.model ? { model: config.model } : undefined);
    this.interpreter = new GoalInterpreter(this.ai);
    this.ragContext = config?.ragContext;
  }

  /** Start with a natural language description, returns the initial interpreted goal */
  async start(description: string): Promise<InterpretedGoal> {
    this.history.push({ role: "user", content: description });

    const result = await this.interpreter.interpret(description, {
      ragContext: this.ragContext,
    });

    this.currentGoal = result.goal;
    this.history.push({
      role: "assistant",
      content: `${result.explanation} (confidence: ${(result.confidence * 100).toFixed(0)}%)`,
    });

    return result;
  }

  /** Refine the current goal with feedback, returns updated goal */
  async refine(feedback: string): Promise<InterpretedGoal> {
    if (!this.currentGoal) {
      throw new Error("No active goal — call start() first");
    }

    this.history.push({ role: "user", content: feedback });

    const result = await this.interpreter.refine(this.currentGoal, feedback, {
      ragContext: this.ragContext,
    });

    this.currentGoal = result.goal;
    this.history.push({
      role: "assistant",
      content: `${result.explanation} (confidence: ${(result.confidence * 100).toFixed(0)}%)`,
    });

    return result;
  }

  /** Get the current goal (null if not started) */
  getCurrentGoal(): Goal | null {
    return this.currentGoal;
  }

  /** Get conversation history */
  getHistory(): ReadonlyArray<{ role: "user" | "assistant"; content: string }> {
    return this.history;
  }

  /** Serialize the current goal as YAML text for display */
  toYaml(): string {
    if (!this.currentGoal) return "";
    const g = this.currentGoal;
    const lines: string[] = [];
    lines.push(`id: ${g.id}`);
    lines.push(`description: ${g.description}`);
    lines.push("observe:");
    for (const o of g.observe) {
      lines.push(`  - type: "${o.type}"`);
    }
    lines.push("then:");
    for (const step of g.then) {
      lines.push(`  - label: ${step.label}`);
      lines.push(`    operator: ${step.operator}`);
      lines.push(`    task: "${step.task}"`);
    }
    if (g.escalate) {
      lines.push("escalate:");
      lines.push(`  afterFailures: ${g.escalate.afterFailures}`);
      lines.push(`  channel: ${g.escalate.channel}`);
      lines.push(`  to: "${g.escalate.to}"`);
    }
    if (g.dedupWindowMs != null) {
      lines.push(`dedupWindowMs: ${g.dedupWindowMs}`);
    }
    return lines.join("\n");
  }
}
