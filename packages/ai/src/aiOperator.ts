/**
 * AIOperator — an operator powered by LLM reasoning.
 *
 * Unlike the static code/comms/infra/data operators that parse task strings
 * with regex, the AI operator:
 *   1. Receives a task in natural language
 *   2. Reasons about what tools/actions to take
 *   3. Can call other operators as sub-tasks
 *   4. Returns a structured result with reasoning
 *
 * This is the "brain" operator — the one that makes OpenMesh intelligent
 * rather than just reactive.
 */

import type { Operator, OperatorContext, OperatorResult } from "@openmesh/core";
import { AIEngine } from "./engine.js";

export class AIOperator implements Operator {
  readonly id = "ai";
  readonly name = "AI Reasoning Operator";
  readonly description =
    "Uses LLM reasoning to analyze problems, generate solutions, summarize findings, and coordinate complex multi-step tasks";

  constructor(private ai: AIEngine) {}

  async execute(ctx: OperatorContext): Promise<OperatorResult> {
    const start = Date.now();

    try {
      const response = await this.ai.prompt(
        `You are an AI operations assistant within the OpenMesh platform.
You are executing a task as part of an automated goal response.

Context:
- Event payload: ${JSON.stringify(ctx.event, null, 2)}

Instructions:
- Analyze the task carefully
- Provide a clear, actionable response
- If you identify a root cause, state it explicitly
- If you recommend actions, list them in priority order
- Be concise but thorough

Respond with a brief summary (1-2 sentences) as the first line,
then details below.`,
        ctx.task,
        { temperature: 0.3 },
      );

      const lines = response.trim().split("\n");
      const summary = lines[0] ?? "Analysis complete";
      const details = lines.slice(1).join("\n").trim();

      return {
        status: "success",
        summary,
        data: details ? { details, fullResponse: response } : { fullResponse: response },
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        status: "failure",
        summary: `AI reasoning failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
      };
    }
  }
}

/** Convenience factory — creates AIOperator with default AIEngine config */
export function createAIOperator(config?: ConstructorParameters<typeof AIEngine>[0]): AIOperator {
  return new AIOperator(new AIEngine(config));
}
