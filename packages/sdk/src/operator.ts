import type { Operator, OperatorContext, OperatorResult } from "@openmesh/core";

/**
 * Operator definition options — passed to defineOperator().
 * Modeled on Claude Code's agent YAML frontmatter + buildTool() pattern.
 */
export interface OperatorDefinition {
  /** Unique operator ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** What this operator does */
  description: string;
  /** Execute a task and return a result */
  execute: (ctx: OperatorContext) => Promise<OperatorResult>;
  /** Optional cleanup */
  dispose?: () => Promise<void>;
}

/**
 * Define an operator — a specialized action executor.
 *
 * @example
 * ```ts
 * import { defineOperator } from "@openmesh/sdk/operator";
 *
 * export default defineOperator({
 *   id: "code",
 *   name: "Code Operator",
 *   description: "Investigates and fixes code issues",
 *   async execute(ctx) {
 *     ctx.log(`Executing task: ${ctx.task}`);
 *     // Use tools to investigate and fix
 *     return { status: "success", summary: "Fixed the flaky test" };
 *   },
 * });
 * ```
 */
export function defineOperator(definition: OperatorDefinition): Operator {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    execute: definition.execute,
    dispose: definition.dispose,
  };
}
