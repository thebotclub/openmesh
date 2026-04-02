/**
 * GoalInterpreter — converts natural language to structured YAML goals.
 *
 * This is the "declare WHAT, we figure out HOW" core promise of OpenMesh.
 * Users describe what they want in plain English; the LLM produces a
 * structured Goal that the GoalEngine can execute.
 *
 * Inspired by Claude Code's tool-selection and intent-parsing pipeline,
 * but applied to operational goals instead of coding tasks.
 */

import type { Goal } from "@openmesh/core";
import { AIEngine } from "./engine.js";

export interface InterpretedGoal {
  /** The structured goal */
  goal: Goal;
  /** LLM's explanation of what it set up */
  explanation: string;
  /** Confidence score 0-1 */
  confidence: number;
}

const SYSTEM_PROMPT = `You are the OpenMesh Goal Interpreter. Your job is to convert natural language
operational requests into structured Goal definitions that the OpenMesh runtime can execute.

Available operators:
- "code": Analyzes code, searches repos, runs tests, generates diffs
- "comms": Sends notifications via configured channels (Slack, email, etc.)
- "infra": Executes infrastructure commands (with approval gates for destructive ops)
- "data": Reads files, runs queries, computes statistics
- "ai": Uses LLM to reason about problems, generate solutions, summarize findings

Available event types (from observers):
- cron.tick — periodic timer
- github.ci.failed, github.ci.passed — CI build results
- github.pr.opened, github.pr.merged — pull request events
- github.push — code pushes
- github.issue.opened — new issues
- http.health.down, http.health.up, http.health.degraded, http.health.latency-spike — health checks
- log.error, log.warn, log.anomaly — log pattern matches
- slack.message, slack.mention — Slack messages
- channel.message — messages from any channel adapter
- webhook.* — custom webhook events

Step templates can use:
- {{event.type}}, {{event.source}}, {{event.timestamp}}
- {{event.payload.<field>}}
- {{steps.<label>.status}}, {{steps.<label>.summary}}, {{steps.<label>.data.<key>}}

Respond with a JSON object:
{
  "goal": { id, description, observe: [{ type, where? }], then: [{ label, operator, task, when?, channel?, to? }], escalate?, dedupWindowMs? },
  "explanation": "what this goal does in plain English",
  "confidence": 0.0-1.0
}`;

export class GoalInterpreter {
  constructor(private ai: AIEngine) {}

  /**
   * Interpret a natural language request into a structured Goal.
   *
   * @example
   * ```ts
   * const result = await interpreter.interpret(
   *   "When CI fails on main, investigate the failure, try to fix it, and notify #engineering"
   * );
   * // result.goal is a fully structured Goal ready for GoalEngine.register()
   * ```
   */
  async interpret(
    naturalLanguage: string,
    context?: { existingGoals?: string[]; existingOperators?: string[]; ragContext?: string },
  ): Promise<InterpretedGoal> {
    const contextAddendum = context
      ? `\n\nExisting goals: ${context.existingGoals?.join(", ") ?? "none"}\nAvailable operators: ${context.existingOperators?.join(", ") ?? "code, comms, infra, data, ai"}`
      : "";

    const ragAddendum = context?.ragContext
      ? `\n\n## Recent Context\n${context.ragContext}`
      : "";

    const result = await this.ai.promptJSON<InterpretedGoal>(
      SYSTEM_PROMPT + contextAddendum + ragAddendum,
      naturalLanguage,
    );

    // Validate required fields
    if (!result.goal?.id || !result.goal?.observe?.length || !result.goal?.then?.length) {
      throw new Error("LLM returned an incomplete goal definition");
    }

    return result;
  }

  /**
   * Refine an existing goal based on feedback.
   */
  async refine(
    currentGoal: Goal,
    feedback: string,
    options?: { ragContext?: string },
  ): Promise<InterpretedGoal> {
    const ragAddendum = options?.ragContext
      ? `\n\n## Recent Context\n${options.ragContext}`
      : "";
    const prompt = `Current goal:\n${JSON.stringify(currentGoal, null, 2)}\n\nUser feedback:\n${feedback}\n\nRefine the goal based on the feedback.`;
    return this.ai.promptJSON<InterpretedGoal>(SYSTEM_PROMPT + ragAddendum, prompt);
  }
}
