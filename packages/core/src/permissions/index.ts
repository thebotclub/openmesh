// ── Permission Types ────────────────────────────────────────────────

/**
 * Permission rule for operator actions.
 * Extended from Claude Code's pattern with ops-specific attributes.
 */
export interface PermissionRule {
  /** Operator ID this rule applies to (or "*" for all) */
  operatorId: string;
  /** Tool name pattern (glob) */
  toolPattern: string;
  /** Behavior when rule matches */
  behavior: "allow" | "deny" | "ask";
  /** Optional: restrict to specific resources (e.g., "staging", "prod") */
  resources?: string[];
  /** Optional: restrict to roles */
  roles?: string[];
  /** Optional: time window (24h format, e.g., "09:00-17:00") */
  timeWindow?: string;
  /** Source of this rule */
  source: "config" | "goal" | "runtime" | "policy";
}

/** Immutable permission context for an operator execution */
export interface PermissionContext {
  operatorId: string;
  goalId?: string;
  resource?: string;
  role?: string;
  rules: readonly PermissionRule[];
}

/** Evaluate whether a tool call is allowed */
export function evaluatePermission(
  ctx: PermissionContext,
  toolName: string,
): { allowed: boolean; reason: string } {
  // Check rules in order: deny first, then allow, then ask
  for (const rule of ctx.rules) {
    if (
      rule.operatorId !== "*" &&
      rule.operatorId !== ctx.operatorId
    ) {
      continue;
    }
    if (!matchToolPattern(rule.toolPattern, toolName)) {
      continue;
    }
    if (rule.resources && ctx.resource && !rule.resources.includes(ctx.resource)) {
      continue;
    }
    if (rule.roles && ctx.role && !rule.roles.includes(ctx.role)) {
      continue;
    }

    if (rule.behavior === "deny") {
      return { allowed: false, reason: `Denied by ${rule.source} rule` };
    }
    if (rule.behavior === "allow") {
      return { allowed: true, reason: `Allowed by ${rule.source} rule` };
    }
  }

  // Default: deny (fail-closed)
  return { allowed: false, reason: "No matching permission rule (default deny)" };
}

function matchToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  const regex = pattern
    .replace(/\./g, "\\.")
    .replace(/\*/g, ".*");
  return new RegExp(`^${regex}$`).test(toolName);
}
