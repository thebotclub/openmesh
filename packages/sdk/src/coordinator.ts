import type { Goal, GoalStep, EscalationPolicy } from "@openmesh/core";
import type { EventPattern } from "@openmesh/core";

/**
 * Goal definition options — passed to defineGoal().
 * Modeled on OpenClaw's routing engine + session cross-messaging pattern.
 */
export interface GoalDefinition {
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
  /** Dedup window in ms */
  dedupWindowMs?: number;
}

/**
 * Define a goal — a declared operational intent.
 *
 * @example
 * ```ts
 * import { defineGoal } from "@openmesh/sdk/coordinator";
 *
 * export default defineGoal({
 *   id: "keep-ci-green",
 *   description: "Keep CI green on main branch",
 *   observe: [{ type: "github.ci.failed", where: { branch: "main" } }],
 *   then: [
 *     { label: "investigate", operator: "code", task: "Investigate CI failure: {{event.summary}}" },
 *     { label: "notify", operator: "comms", task: "CI failed: {{steps.investigate.summary}}", when: "investigate.status != 'success'" },
 *   ],
 *   escalate: { afterFailures: 2, channel: "slack", to: "#oncall" },
 * });
 * ```
 */
export function defineGoal(definition: GoalDefinition): Goal {
  return {
    id: definition.id,
    description: definition.description,
    observe: definition.observe,
    then: definition.then,
    escalate: definition.escalate,
    dedupWindowMs: definition.dedupWindowMs,
  };
}
