/**
 * OperatorPlanner — AI-powered operator selection and execution planning.
 *
 * When a goal fires, the planner:
 *   1. Examines the event payload
 *   2. Reviews available operators and their capabilities
 *   3. Generates an optimal execution plan (potentially modifying/expanding
 *      the static goal steps with dynamic reasoning)
 *
 * This is what turns OpenMesh from a "static YAML → action" system into
 * an "AI figures out the best remediation" system.
 */

import type { ObservationEvent, Operator, OperatorResult } from "@openmesh/core";
import type { Goal } from "@openmesh/core";
import { AIEngine } from "./engine.js";

export interface PlannedStep {
  label: string;
  operator: string;
  task: string;
  reasoning: string;
  when?: string;
  estimatedDurationMs?: number;
}

export interface ExecutionPlan {
  goalId: string;
  steps: PlannedStep[];
  reasoning: string;
  estimatedTotalMs: number;
}

const PLANNER_SYSTEM = `You are the OpenMesh Execution Planner. Given an event that triggered a goal,
and the list of available operators, generate an optimized execution plan.

You may:
- Reorder steps for efficiency
- Add investigation steps before action steps
- Add verification steps after action steps
- Split complex tasks into smaller sub-tasks
- Skip steps that don't apply to the specific event

Each step must use one of the available operators. Your plan should be practical,
safe (investigate before acting), and complete.

Respond with JSON:
{
  "goalId": "string",
  "steps": [{ "label": "string", "operator": "string", "task": "string", "reasoning": "string", "when": "optional condition", "estimatedDurationMs": number }],
  "reasoning": "why this plan is optimal",
  "estimatedTotalMs": number
}`;

export class OperatorPlanner {
  constructor(private ai: AIEngine) {}

  /**
   * Generate an execution plan for a matched goal + event.
   *
   * If the goal already has explicit steps, the planner enhances them.
   * If the goal has a high-level description only, the planner generates
   * steps from scratch.
   */
  async plan(
    goal: Goal,
    event: ObservationEvent,
    availableOperators: Operator[],
    recentResults?: Map<string, OperatorResult>,
    options?: { ragContext?: string },
  ): Promise<ExecutionPlan> {
    const operatorDescriptions = availableOperators
      .map((op) => `- "${op.id}": ${op.description}`)
      .join("\n");

    const recentContext = recentResults?.size
      ? `\nRecent step results:\n${[...recentResults.entries()]
          .map(([label, r]) => `  ${label}: ${r.status} — ${r.summary}`)
          .join("\n")}`
      : "";

    const prompt = `Goal: ${goal.id} — ${goal.description}

Event:
  type: ${event.type}
  source: ${event.source}
  payload: ${JSON.stringify(event.payload, null, 2)}

Available operators:
${operatorDescriptions}

Existing steps in goal definition:
${goal.then.map((s, i) => `  ${i + 1}. [${s.label}] operator=${s.operator}: ${s.task}`).join("\n")}
${recentContext}

Generate the best execution plan.`;

    const ragAddendum = options?.ragContext
      ? `\n\n## Recent Context\n${options.ragContext}`
      : "";

    return this.ai.promptJSON<ExecutionPlan>(PLANNER_SYSTEM + ragAddendum, prompt);
  }

  /**
   * Re-plan after a step failure — adaptive remediation.
   */
  async replan(
    goal: Goal,
    event: ObservationEvent,
    failedStep: string,
    failureReason: string,
    availableOperators: Operator[],
    completedResults: Map<string, OperatorResult>,
    options?: { ragContext?: string },
  ): Promise<ExecutionPlan> {
    const operatorDescriptions = availableOperators
      .map((op) => `- "${op.id}": ${op.description}`)
      .join("\n");

    const prompt = `Goal: ${goal.id} — ${goal.description}

Event:
  type: ${event.type}
  source: ${event.source}

STEP FAILED: "${failedStep}" — ${failureReason}

Completed steps so far:
${[...completedResults.entries()]
  .map(([label, r]) => `  ${label}: ${r.status} — ${r.summary}`)
  .join("\n")}

Available operators:
${operatorDescriptions}

Generate a recovery plan. You may retry the failed step with changes,
try alternative approaches, or escalate if recovery isn't possible.`;

    const ragAddendum = options?.ragContext
      ? `\n\n## Recent Context\n${options.ragContext}`
      : "";

    return this.ai.promptJSON<ExecutionPlan>(PLANNER_SYSTEM + ragAddendum, prompt);
  }
}
