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
import { PromptTemplateRegistry } from "./promptTemplates.js";

export interface InterpretedGoal {
  /** The structured goal */
  goal: Goal;
  /** LLM's explanation of what it set up */
  explanation: string;
  /** Confidence score 0-1 */
  confidence: number;
}



export class GoalInterpreter {
  private registry: PromptTemplateRegistry;

  constructor(private ai: AIEngine, registry?: PromptTemplateRegistry) {
    this.registry = registry ?? new PromptTemplateRegistry();
  }

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
    const domain = this.registry.detectDomain(naturalLanguage);
    const template = this.registry.getWithFallback(domain, "interpret");

    const contextAddendum = context
      ? `\n\nExisting goals: ${context.existingGoals?.join(", ") ?? "none"}\nAvailable operators: ${context.existingOperators?.join(", ") ?? "code, comms, infra, data, ai"}`
      : "";

    const ragAddendum = context?.ragContext
      ? `\n\n## Recent Context\n${context.ragContext}`
      : "";

    const systemPrompt = template.systemPrompt + contextAddendum + ragAddendum;
    const userPrompt = this.registry.render(template, { description: naturalLanguage });

    const result = await this.ai.promptJSON<InterpretedGoal>(
      systemPrompt,
      userPrompt,
      { temperature: template.temperature },
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
    const domain = this.registry.detectDomain(currentGoal.description ?? "");
    const template = this.registry.getWithFallback(domain, "refine");
    const ragAddendum = options?.ragContext
      ? `\n\n## Recent Context\n${options.ragContext}`
      : "";
    const prompt = this.registry.render(template, {
      currentGoal: JSON.stringify(currentGoal, null, 2),
      feedback,
    });
    return this.ai.promptJSON<InterpretedGoal>(
      template.systemPrompt + ragAddendum,
      prompt,
      { temperature: template.temperature },
    );
  }
}
