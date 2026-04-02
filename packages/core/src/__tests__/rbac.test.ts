import { describe, it, expect, beforeEach } from "vitest";
import {
  RBACManager,
  BUILTIN_ROLES,
  type RBACConfig,
  type Role,
  type Principal,
} from "../rbac.js";

// ── Helpers ─────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<RBACConfig>): RBACConfig {
  return {
    enabled: true,
    principals: [
      { id: "alice", type: "user", name: "Alice", roles: ["admin"] },
      { id: "bob", type: "user", name: "Bob", roles: ["operator"] },
      { id: "carol", type: "apikey", name: "Carol", roles: ["viewer"] },
    ],
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("RBACManager", () => {
  describe("RBAC disabled", () => {
    it("allows everything when disabled", () => {
      const rbac = new RBACManager({ enabled: false });
      expect(rbac.check("nobody", "operator:code", "execute")).toBe(true);
      expect(rbac.check("nobody", "goal:anything", "delete")).toBe(true);
      expect(rbac.enabled).toBe(false);
    });

    it("defaults to disabled", () => {
      const rbac = new RBACManager();
      expect(rbac.enabled).toBe(false);
      expect(rbac.check("unknown", "operator:code", "execute")).toBe(true);
    });
  });

  describe("built-in roles", () => {
    let rbac: RBACManager;

    beforeEach(() => {
      rbac = new RBACManager(makeConfig());
    });

    it("admin has full access", () => {
      expect(rbac.check("alice", "operator:code", "execute")).toBe(true);
      expect(rbac.check("alice", "operator:infra", "delete")).toBe(true);
      expect(rbac.check("alice", "goal:myGoal", "write")).toBe(true);
      expect(rbac.check("alice", "event:inject", "inject")).toBe(true);
    });

    it("operator can execute operators", () => {
      expect(rbac.check("bob", "operator:code", "execute")).toBe(true);
      expect(rbac.check("bob", "operator:infra", "execute")).toBe(true);
    });

    it("operator can read goals and events", () => {
      expect(rbac.check("bob", "goal:myGoal", "read")).toBe(true);
      expect(rbac.check("bob", "event:cron.tick", "read")).toBe(true);
    });

    it("operator can inject events", () => {
      expect(rbac.check("bob", "event:cron.tick", "inject")).toBe(true);
    });

    it("operator cannot delete", () => {
      expect(rbac.check("bob", "operator:code", "delete")).toBe(false);
      expect(rbac.check("bob", "goal:myGoal", "write")).toBe(false);
    });

    it("viewer can only read", () => {
      expect(rbac.check("carol", "operator:code", "read")).toBe(true);
      expect(rbac.check("carol", "goal:myGoal", "read")).toBe(true);
      expect(rbac.check("carol", "event:cron", "read")).toBe(true);
    });

    it("viewer cannot execute or write", () => {
      expect(rbac.check("carol", "operator:code", "execute")).toBe(false);
      expect(rbac.check("carol", "goal:myGoal", "write")).toBe(false);
      expect(rbac.check("carol", "event:inject", "inject")).toBe(false);
    });
  });

  describe("wildcard matching", () => {
    let rbac: RBACManager;

    beforeEach(() => {
      rbac = new RBACManager(makeConfig());
    });

    it("operator:* matches operator:code", () => {
      expect(rbac.check("bob", "operator:code", "execute")).toBe(true);
    });

    it("operator:* matches operator:infra", () => {
      expect(rbac.check("bob", "operator:infra", "execute")).toBe(true);
    });

    it("admin * resource matches anything", () => {
      expect(rbac.check("alice", "some:random:resource", "anything")).toBe(true);
    });
  });

  describe("custom roles", () => {
    it("supports a custom role with specific permissions", () => {
      const customRole: Role = {
        id: "code-only",
        name: "Code Operator Only",
        permissions: [
          { resource: "operator:code", actions: ["execute"] },
        ],
      };

      const rbac = new RBACManager({
        enabled: true,
        roles: [customRole],
        principals: [
          { id: "dave", type: "user", name: "Dave", roles: ["code-only"] },
        ],
      });

      expect(rbac.check("dave", "operator:code", "execute")).toBe(true);
      expect(rbac.check("dave", "operator:infra", "execute")).toBe(false);
      expect(rbac.check("dave", "goal:anything", "read")).toBe(false);
    });
  });

  describe("convenience methods", () => {
    let rbac: RBACManager;

    beforeEach(() => {
      rbac = new RBACManager(makeConfig());
    });

    it("canExecuteOperator checks operator:id execute", () => {
      expect(rbac.canExecuteOperator("alice", "code")).toBe(true);
      expect(rbac.canExecuteOperator("bob", "infra")).toBe(true);
      expect(rbac.canExecuteOperator("carol", "code")).toBe(false);
    });

    it("canInjectEvent checks event inject", () => {
      expect(rbac.canInjectEvent("alice")).toBe(true);
      expect(rbac.canInjectEvent("bob")).toBe(true);
      expect(rbac.canInjectEvent("carol")).toBe(false);
    });
  });

  describe("dynamic role management", () => {
    let rbac: RBACManager;

    beforeEach(() => {
      rbac = new RBACManager(makeConfig());
    });

    it("adds a new role and principal", () => {
      rbac.addRole({
        id: "deployer",
        name: "Deployer",
        permissions: [{ resource: "operator:infra", actions: ["execute"] }],
      });
      rbac.addPrincipal({ id: "eve", type: "service", name: "Eve", roles: ["deployer"] });

      expect(rbac.check("eve", "operator:infra", "execute")).toBe(true);
      expect(rbac.check("eve", "operator:code", "execute")).toBe(false);
    });

    it("removes a custom role", () => {
      rbac.addRole({ id: "temp", name: "Temporary", permissions: [] });
      rbac.removeRole("temp");
      expect(rbac.getRole("temp")).toBeUndefined();
    });

    it("cannot remove a built-in role", () => {
      expect(() => rbac.removeRole("admin")).toThrow("Cannot remove built-in role");
    });

    it("removes a principal", () => {
      rbac.removePrincipal("bob");
      expect(rbac.getPrincipal("bob")).toBeUndefined();
    });

    it("rejects invalid role id", () => {
      expect(() => rbac.addRole({ id: "no spaces!", name: "Bad", permissions: [] })).toThrow("Invalid role id");
    });

    it("rejects invalid principal id", () => {
      expect(() =>
        rbac.addPrincipal({ id: "", type: "user", name: "Empty", roles: [] }),
      ).toThrow("Invalid principal id");
    });
  });

  describe("default role", () => {
    it("unknown principal gets default role when configured", () => {
      const rbac = new RBACManager({
        enabled: true,
        defaultRole: "viewer",
      });

      expect(rbac.check("unknown-user", "operator:code", "read")).toBe(true);
      expect(rbac.check("unknown-user", "operator:code", "execute")).toBe(false);
    });

    it("unknown principal with no default is denied", () => {
      const rbac = new RBACManager({ enabled: true });

      expect(rbac.check("unknown-user", "operator:code", "read")).toBe(false);
      expect(rbac.check("unknown-user", "operator:code", "execute")).toBe(false);
    });
  });

  describe("getPermissions", () => {
    it("returns expanded permissions from roles", () => {
      const rbac = new RBACManager(makeConfig());
      const perms = rbac.getPermissions("bob");
      expect(perms.length).toBeGreaterThan(0);
      expect(perms.some((p) => p.resource === "operator:*")).toBe(true);
    });

    it("returns empty for unknown principal with no default", () => {
      const rbac = new RBACManager({ enabled: true });
      expect(rbac.getPermissions("ghost")).toEqual([]);
    });
  });

  describe("listing", () => {
    it("lists all roles including builtins", () => {
      const rbac = new RBACManager(makeConfig());
      const roles = rbac.listRoles();
      expect(roles.length).toBeGreaterThanOrEqual(BUILTIN_ROLES.length);
      expect(roles.some((r) => r.id === "admin")).toBe(true);
    });

    it("lists principals", () => {
      const rbac = new RBACManager(makeConfig());
      expect(rbac.listPrincipals().length).toBe(3);
    });
  });

  describe("input validation", () => {
    it("rejects invalid resource patterns", () => {
      const rbac = new RBACManager(makeConfig());
      // Resource with disallowed characters
      expect(rbac.check("alice", "operator:<script>", "read")).toBe(false);
      expect(rbac.check("alice", "", "read")).toBe(false);
    });
  });
});
