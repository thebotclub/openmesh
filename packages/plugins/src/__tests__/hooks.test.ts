import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  HookManager,
  type HookContext,
} from "../hooks.js";
import type { PluginManifest, LoadedPlugin } from "../loader.js";

describe("HookManager", () => {
  let manager: HookManager;

  beforeEach(() => {
    manager = new HookManager();
  });

  // ── Registration ────────────────────────────────────────────────

  describe("registration", () => {
    it("register adds handler to correct hook point", () => {
      const handler = vi.fn();
      manager.register({
        pluginName: "test-plugin",
        hook: "before:goal:execute",
        handler,
      });

      const hooks = manager.listFor("before:goal:execute");
      expect(hooks).toHaveLength(1);
      expect(hooks[0]!.pluginName).toBe("test-plugin");
      expect(hooks[0]!.handler).toBe(handler);
    });

    it("register with priority sorts lower-first", () => {
      manager.register({
        pluginName: "high",
        hook: "before:goal:execute",
        handler: vi.fn(),
        priority: 200,
      });
      manager.register({
        pluginName: "low",
        hook: "before:goal:execute",
        handler: vi.fn(),
        priority: 10,
      });
      manager.register({
        pluginName: "mid",
        hook: "before:goal:execute",
        handler: vi.fn(),
        priority: 50,
      });

      const hooks = manager.listFor("before:goal:execute");
      expect(hooks.map((h) => h.pluginName)).toEqual(["low", "mid", "high"]);
    });

    it("default priority is 100", () => {
      manager.register({
        pluginName: "default-pri",
        hook: "on:error",
        handler: vi.fn(),
      });
      manager.register({
        pluginName: "explicit-99",
        hook: "on:error",
        handler: vi.fn(),
        priority: 99,
      });

      const hooks = manager.listFor("on:error");
      expect(hooks[0]!.pluginName).toBe("explicit-99");
      expect(hooks[1]!.pluginName).toBe("default-pri");
    });

    it("unregister removes all hooks for a plugin", () => {
      manager.register({
        pluginName: "doomed",
        hook: "before:goal:execute",
        handler: vi.fn(),
      });
      manager.register({
        pluginName: "doomed",
        hook: "after:goal:execute",
        handler: vi.fn(),
      });
      manager.register({
        pluginName: "survivor",
        hook: "before:goal:execute",
        handler: vi.fn(),
      });

      manager.unregister("doomed");

      expect(manager.listFor("before:goal:execute")).toHaveLength(1);
      expect(manager.listFor("before:goal:execute")[0]!.pluginName).toBe("survivor");
      expect(manager.listFor("after:goal:execute")).toHaveLength(0);
    });

    it("unregister only removes targeted plugin's hooks", () => {
      manager.register({
        pluginName: "alpha",
        hook: "on:error",
        handler: vi.fn(),
      });
      manager.register({
        pluginName: "beta",
        hook: "on:error",
        handler: vi.fn(),
      });

      manager.unregister("alpha");

      const hooks = manager.listFor("on:error");
      expect(hooks).toHaveLength(1);
      expect(hooks[0]!.pluginName).toBe("beta");
    });

    it("list returns all registered hooks", () => {
      manager.register({
        pluginName: "a",
        hook: "before:goal:execute",
        handler: vi.fn(),
      });
      manager.register({
        pluginName: "b",
        hook: "after:operator:execute",
        handler: vi.fn(),
      });
      manager.register({
        pluginName: "c",
        hook: "on:error",
        handler: vi.fn(),
      });

      const all = manager.list();
      expect(all).toHaveLength(3);
      expect(all.map((h) => h.pluginName).sort()).toEqual(["a", "b", "c"]);
    });

    it("listFor returns hooks for specific point", () => {
      manager.register({
        pluginName: "x",
        hook: "on:plugin:loaded",
        handler: vi.fn(),
      });
      manager.register({
        pluginName: "y",
        hook: "on:error",
        handler: vi.fn(),
      });

      expect(manager.listFor("on:plugin:loaded")).toHaveLength(1);
      expect(manager.listFor("on:error")).toHaveLength(1);
      expect(manager.listFor("before:goal:execute")).toHaveLength(0);
    });

    it("clear removes everything", () => {
      manager.register({
        pluginName: "a",
        hook: "before:goal:execute",
        handler: vi.fn(),
      });
      manager.register({
        pluginName: "b",
        hook: "on:error",
        handler: vi.fn(),
      });

      manager.clear();

      expect(manager.list()).toHaveLength(0);
    });
  });

  // ── Firing ──────────────────────────────────────────────────────

  describe("firing", () => {
    it("fire calls all handlers for a hook point", async () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      manager.register({ pluginName: "a", hook: "on:error", handler: h1 });
      manager.register({ pluginName: "b", hook: "on:error", handler: h2 });

      await manager.fire("on:error", { message: "boom" });

      expect(h1).toHaveBeenCalledOnce();
      expect(h2).toHaveBeenCalledOnce();
    });

    it("fire calls handlers in priority order", async () => {
      const order: string[] = [];
      manager.register({
        pluginName: "last",
        hook: "after:goal:execute",
        handler: () => { order.push("last"); },
        priority: 300,
      });
      manager.register({
        pluginName: "first",
        hook: "after:goal:execute",
        handler: () => { order.push("first"); },
        priority: 1,
      });
      manager.register({
        pluginName: "middle",
        hook: "after:goal:execute",
        handler: () => { order.push("middle"); },
        priority: 50,
      });

      await manager.fire("after:goal:execute", {});

      expect(order).toEqual(["first", "middle", "last"]);
    });

    it("fire passes context correctly", async () => {
      let captured: HookContext | undefined;
      manager.register({
        pluginName: "spy",
        hook: "before:operator:execute",
        handler: (ctx) => { captured = ctx; },
      });

      await manager.fire("before:operator:execute", { operatorId: "op-1" });

      expect(captured).toBeDefined();
      expect(captured!.hook).toBe("before:operator:execute");
      expect(captured!.data).toEqual({ operatorId: "op-1" });
      expect(captured!.timestamp).toBeTruthy();
    });

    it("fire collects errors without stopping other handlers", async () => {
      const h1 = vi.fn(() => { throw new Error("h1 fail"); });
      const h2 = vi.fn();
      manager.register({ pluginName: "bad", hook: "on:error", handler: h1 });
      manager.register({ pluginName: "good", hook: "on:error", handler: h2 });

      const { errors } = await manager.fire("on:error", {});

      expect(h2).toHaveBeenCalledOnce();
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe("h1 fail");
    });

    it("fire with no registered handlers returns empty errors", async () => {
      const { ctx, errors } = await manager.fire("on:plugin:loaded", { name: "x" });

      expect(errors).toHaveLength(0);
      expect(ctx.hook).toBe("on:plugin:loaded");
    });

    it("before: hooks can set cancelled=true to stop remaining handlers", async () => {
      const h2 = vi.fn();
      manager.register({
        pluginName: "blocker",
        hook: "before:goal:execute",
        handler: (ctx) => { ctx.cancelled = true; ctx.cancelReason = "blocked"; },
        priority: 1,
      });
      manager.register({
        pluginName: "never-runs",
        hook: "before:goal:execute",
        handler: h2,
        priority: 99,
      });

      const { ctx } = await manager.fire("before:goal:execute", {});

      expect(ctx.cancelled).toBe(true);
      expect(ctx.cancelReason).toBe("blocked");
      expect(h2).not.toHaveBeenCalled();
    });

    it("after: hooks cannot cancel (cancelled flag ignored)", async () => {
      const h2 = vi.fn();
      manager.register({
        pluginName: "tries-cancel",
        hook: "after:goal:execute",
        handler: (ctx) => { ctx.cancelled = true; },
        priority: 1,
      });
      manager.register({
        pluginName: "still-runs",
        hook: "after:goal:execute",
        handler: h2,
        priority: 99,
      });

      await manager.fire("after:goal:execute", {});

      expect(h2).toHaveBeenCalledOnce();
    });

    it("on: hooks fire independently", async () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      manager.register({
        pluginName: "a",
        hook: "on:plugin:loaded",
        handler: (ctx) => { ctx.cancelled = true; h1(); },
        priority: 1,
      });
      manager.register({
        pluginName: "b",
        hook: "on:plugin:loaded",
        handler: h2,
        priority: 99,
      });

      await manager.fire("on:plugin:loaded", {});

      expect(h1).toHaveBeenCalledOnce();
      expect(h2).toHaveBeenCalledOnce();
    });

    it("async handlers are awaited", async () => {
      const order: string[] = [];
      manager.register({
        pluginName: "async-first",
        hook: "after:operator:execute",
        handler: async () => {
          await new Promise((r) => setTimeout(r, 10));
          order.push("async");
        },
        priority: 1,
      });
      manager.register({
        pluginName: "sync-second",
        hook: "after:operator:execute",
        handler: () => { order.push("sync"); },
        priority: 99,
      });

      await manager.fire("after:operator:execute", {});

      expect(order).toEqual(["async", "sync"]);
    });
  });

  // ── Cancellation ────────────────────────────────────────────────

  describe("cancellation", () => {
    it("cancelled before:goal:execute stops remaining handlers", async () => {
      const second = vi.fn();
      manager.register({
        pluginName: "cancel",
        hook: "before:goal:execute",
        handler: (ctx) => { ctx.cancelled = true; ctx.cancelReason = "nope"; },
        priority: 1,
      });
      manager.register({
        pluginName: "skipped",
        hook: "before:goal:execute",
        handler: second,
        priority: 50,
      });

      const { ctx } = await manager.fire("before:goal:execute", { goalId: "g1" });

      expect(ctx.cancelled).toBe(true);
      expect(second).not.toHaveBeenCalled();
    });

    it("cancelled before:operator:execute stops remaining handlers", async () => {
      const second = vi.fn();
      manager.register({
        pluginName: "cancel",
        hook: "before:operator:execute",
        handler: (ctx) => { ctx.cancelled = true; },
        priority: 1,
      });
      manager.register({
        pluginName: "skipped",
        hook: "before:operator:execute",
        handler: second,
        priority: 50,
      });

      await manager.fire("before:operator:execute", {});

      expect(second).not.toHaveBeenCalled();
    });

    it("cancelReason is preserved", async () => {
      manager.register({
        pluginName: "cancel",
        hook: "before:goal:execute",
        handler: (ctx) => {
          ctx.cancelled = true;
          ctx.cancelReason = "rate-limited";
        },
      });

      const { ctx } = await manager.fire("before:goal:execute", {});

      expect(ctx.cancelReason).toBe("rate-limited");
    });

    it("non-before hooks don't stop on cancelled", async () => {
      const h2 = vi.fn();
      manager.register({
        pluginName: "sets-cancel",
        hook: "on:error",
        handler: (ctx) => { ctx.cancelled = true; },
        priority: 1,
      });
      manager.register({
        pluginName: "still-runs",
        hook: "on:error",
        handler: h2,
        priority: 99,
      });

      await manager.fire("on:error", {});

      expect(h2).toHaveBeenCalledOnce();
    });
  });

  // ── Error Isolation ─────────────────────────────────────────────

  describe("error isolation", () => {
    it("handler throwing doesn't prevent next handler from running", async () => {
      const good = vi.fn();
      manager.register({
        pluginName: "bad",
        hook: "after:goal:execute",
        handler: () => { throw new Error("fail"); },
        priority: 1,
      });
      manager.register({
        pluginName: "good",
        hook: "after:goal:execute",
        handler: good,
        priority: 99,
      });

      await manager.fire("after:goal:execute", {});

      expect(good).toHaveBeenCalledOnce();
    });

    it("handler errors are collected in errors array", async () => {
      manager.register({
        pluginName: "err1",
        hook: "on:error",
        handler: () => { throw new Error("first"); },
      });
      manager.register({
        pluginName: "err2",
        hook: "on:error",
        handler: () => { throw new Error("second"); },
      });

      const { errors } = await manager.fire("on:error", {});

      expect(errors).toHaveLength(2);
      expect(errors[0]!.message).toBe("first");
      expect(errors[1]!.message).toBe("second");
    });

    it("non-Error throws are wrapped in Error", async () => {
      manager.register({
        pluginName: "throws-string",
        hook: "on:error",
        handler: () => { throw "raw string"; }, // eslint-disable-line no-throw-literal
      });

      const { errors } = await manager.fire("on:error", {});

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
      expect(errors[0]!.message).toBe("raw string");
    });
  });

  // ── Integration with PluginManifest ─────────────────────────────

  describe("integration with PluginManifest", () => {
    it("PluginManifest with hooks field is valid", () => {
      const manifest: PluginManifest = {
        name: "test-plugin",
        version: "1.0.0",
        type: "operator",
        entry: "./dist/index.js",
        hooks: [
          { hook: "before:goal:execute", handler: "onBeforeGoal", priority: 10 },
          { hook: "on:error", handler: "onError" },
        ],
      };

      expect(manifest.hooks).toHaveLength(2);
      expect(manifest.hooks![0]!.hook).toBe("before:goal:execute");
      expect(manifest.hooks![0]!.handler).toBe("onBeforeGoal");
      expect(manifest.hooks![0]!.priority).toBe(10);
      expect(manifest.hooks![1]!.priority).toBeUndefined();
    });

    it("LoadedPlugin with hookHandlers is valid", () => {
      const loaded: LoadedPlugin = {
        manifest: {
          name: "test-plugin",
          version: "1.0.0",
          type: "bundle",
          entry: "./dist/index.js",
        },
        observers: [],
        operators: [],
        goals: [],
        hookHandlers: [
          {
            hook: "before:goal:execute",
            handler: () => {},
            priority: 10,
          },
          {
            hook: "on:error",
            handler: async () => {},
          },
        ],
      };

      expect(loaded.hookHandlers).toHaveLength(2);
      expect(loaded.hookHandlers![0]!.hook).toBe("before:goal:execute");
      expect(typeof loaded.hookHandlers![0]!.handler).toBe("function");
    });
  });
});
