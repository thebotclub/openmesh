/**
 * @openmesh/core — Role-Based Access Control (RBAC) system.
 *
 * Provides scoped permissions for operator execution, event injection,
 * goal management, and other mesh operations.
 */

// ── Types ───────────────────────────────────────────────────────────

/** Permission for a specific resource/action combination */
export interface Permission {
  /** Resource pattern, e.g. "operator:code", "operator:*", "goal:*", "event:inject" */
  resource: string;
  /** Allowed actions, e.g. ["execute", "read", "write", "delete"]. "*" matches any. */
  actions: string[];
}

/** Role with a set of permissions */
export interface Role {
  id: string;
  name: string;
  description?: string;
  permissions: Permission[];
}

/** Principal (user, API key, or service) */
export interface Principal {
  id: string;
  type: "user" | "apikey" | "service";
  name: string;
  roles: string[];
  metadata?: Record<string, unknown>;
}

/** RBAC configuration */
export interface RBACConfig {
  /** When false/undefined, all checks pass (permissive). Default: false */
  enabled?: boolean;
  /** Custom roles (merged with built-ins) */
  roles?: Role[];
  /** Known principals */
  principals?: Principal[];
  /** Role assigned to unknown/unauthenticated principals */
  defaultRole?: string;
}

// ── Built-in Roles ──────────────────────────────────────────────────

export const BUILTIN_ROLES: Role[] = [
  {
    id: "admin",
    name: "Administrator",
    description: "Full access to all resources and actions",
    permissions: [{ resource: "*", actions: ["*"] }],
  },
  {
    id: "operator",
    name: "Operator",
    description: "Can execute operators and read/inject events",
    permissions: [
      { resource: "operator:*", actions: ["execute"] },
      { resource: "goal:*", actions: ["read"] },
      { resource: "event:*", actions: ["read", "inject"] },
    ],
  },
  {
    id: "viewer",
    name: "Viewer",
    description: "Read-only access to all resources",
    permissions: [
      { resource: "operator:*", actions: ["read"] },
      { resource: "goal:*", actions: ["read"] },
      { resource: "event:*", actions: ["read"] },
    ],
  },
];

// ── Pattern Matching ────────────────────────────────────────────────

const VALID_ID = /^[a-zA-Z0-9._:-]+$/;

/** Validate that an ID contains only safe characters */
function isValidId(id: string): boolean {
  return id.length > 0 && id.length <= 256 && VALID_ID.test(id);
}

/** Sanitize a resource string — allow alphanumerics, dots, colons, dashes, underscores, and `*` */
function isValidResource(resource: string): boolean {
  return resource.length > 0 && resource.length <= 256 && /^[a-zA-Z0-9._:*-]+$/.test(resource);
}

/**
 * Match a resource pattern against a concrete resource.
 * - "*" matches everything
 * - "operator:*" matches "operator:code", "operator:infra", etc.
 * - Exact match otherwise
 */
function matchResource(pattern: string, resource: string): boolean {
  if (pattern === "*") return true;
  if (pattern === resource) return true;

  // Convert glob to regex: `*` matches any non-colon segment
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^:]*");
  return new RegExp(`^${regex}$`).test(resource);
}

/** Check if an action list includes the requested action */
function matchAction(allowed: string[], action: string): boolean {
  return allowed.includes("*") || allowed.includes(action);
}

// ── RBACManager ─────────────────────────────────────────────────────

export class RBACManager {
  private roles = new Map<string, Role>();
  private principals = new Map<string, Principal>();
  private _enabled: boolean;
  private defaultRoleId: string | undefined;

  constructor(config?: RBACConfig) {
    this._enabled = config?.enabled ?? false;
    this.defaultRoleId = config?.defaultRole;

    // Load built-in roles first
    for (const role of BUILTIN_ROLES) {
      this.roles.set(role.id, role);
    }

    // Merge user-supplied roles (override built-ins if same id)
    if (config?.roles) {
      for (const role of config.roles) {
        this.roles.set(role.id, role);
      }
    }

    // Load principals
    if (config?.principals) {
      for (const p of config.principals) {
        this.principals.set(p.id, p);
      }
    }
  }

  get enabled(): boolean {
    return this._enabled;
  }

  // ── Role Management ─────────────────────────────────────────────

  addRole(role: Role): void {
    if (!isValidId(role.id)) {
      throw new Error(`Invalid role id: ${role.id}`);
    }
    this.roles.set(role.id, role);
  }

  removeRole(id: string): void {
    // Don't allow removing built-in roles
    if (BUILTIN_ROLES.some((r) => r.id === id)) {
      throw new Error(`Cannot remove built-in role: ${id}`);
    }
    this.roles.delete(id);
  }

  getRole(id: string): Role | undefined {
    return this.roles.get(id);
  }

  listRoles(): Role[] {
    return [...this.roles.values()];
  }

  // ── Principal Management ────────────────────────────────────────

  addPrincipal(principal: Principal): void {
    if (!isValidId(principal.id)) {
      throw new Error(`Invalid principal id: ${principal.id}`);
    }
    this.principals.set(principal.id, principal);
  }

  removePrincipal(id: string): void {
    this.principals.delete(id);
  }

  getPrincipal(id: string): Principal | undefined {
    return this.principals.get(id);
  }

  listPrincipals(): Principal[] {
    return [...this.principals.values()];
  }

  // ── Permission Checks ──────────────────────────────────────────

  /**
   * Check if a principal can perform `action` on `resource`.
   * When RBAC is disabled, always returns true.
   */
  check(principalId: string, resource: string, action: string): boolean {
    if (!this._enabled) return true;

    if (!isValidResource(resource)) return false;

    const permissions = this.getPermissions(principalId);
    return permissions.some(
      (p) => matchResource(p.resource, resource) && matchAction(p.actions, action),
    );
  }

  /** Get all permissions for a principal (expanded from their roles) */
  getPermissions(principalId: string): Permission[] {
    const principal = this.principals.get(principalId);
    const roleIds = principal?.roles ?? (this.defaultRoleId ? [this.defaultRoleId] : []);

    const permissions: Permission[] = [];
    for (const roleId of roleIds) {
      const role = this.roles.get(roleId);
      if (role) {
        permissions.push(...role.permissions);
      }
    }
    return permissions;
  }

  /** Convenience: check if a principal can execute a specific operator */
  canExecuteOperator(principalId: string, operatorId: string): boolean {
    return this.check(principalId, `operator:${operatorId}`, "execute");
  }

  /** Convenience: check if a principal can inject events */
  canInjectEvent(principalId: string): boolean {
    return this.check(principalId, "event:*", "inject");
  }
}
