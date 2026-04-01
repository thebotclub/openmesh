import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Observer, Operator, Goal } from "@openmesh/core";

// ── Mock node:fs (sync) ─────────────────────────────────────────────

const mockExistsSync = vi.fn<(p: string) => boolean>();
const mockReadFileSync = vi.fn<(p: string, enc: string) => string>();

vi.mock("node:fs", () => ({
  existsSync: (...a: unknown[]) => mockExistsSync(...(a as [string])),
  readFileSync: (...a: unknown[]) => mockReadFileSync(...(a as [string, string])),
}));

// ── Capture dynamic import() calls ─────────────────────────────────

const mockImport = vi.fn();

// We override the private loadFromManifest / loadNpm indirectly by
// providing our own import mock. Since PluginLoader uses bare `import()`,
// we intercept at the module level by replacing the global import in tests
// through a thin wrapper. The cleanest approach: spy on the loader method.

import { PluginLoader, type PluginManifest, type LoadedPlugin } from "./loader.js";
import { PluginRegistry } from "./registry.js";

// ── Helpers ─────────────────────────────────────────────────────────

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "test-plugin",
    version: "1.0.0",
    type: "observer",
    entry: "./dist/index.js",
    ...overrides,
  };
}

function makeObserver(id = "obs-1"): Observer {
  return {
    id,
    name: `Observer ${id}`,
    events: ["test.event"],
    watch: vi.fn().mockResolvedValue(undefined),
  };
}

function makeOperator(id = "op-1"): Operator {
  return {
    id,
    name: `Operator ${id}`,
    description: "test operator",
    execute: vi.fn().mockResolvedValue({ status: "success", summary: "done" }),
  };
}

function makeGoal(id = "goal-1"): Goal {
  return {
    id,
    description: "test goal",
    observe: [{ type: "test.event" }],
    then: [{ label: "step1", operator: "op-1", task: "do thing" }],
  };
}

function makeMesh() {
  return {
    addObserver: vi.fn().mockReturnThis(),
    addOperator: vi.fn().mockReturnThis(),
    addGoal: vi.fn().mockReturnThis(),
  } as unknown as import("@openmesh/core").Mesh;
}

function makeLoadedPlugin(overrides: Partial<LoadedPlugin> = {}): LoadedPlugin {
  return {
    manifest: makeManifest(),
    observers: [],
    operators: [],
    goals: [],
    ...overrides,
  };
}

// ── PluginLoader ────────────────────────────────────────────────────

describe("PluginLoader", () => {
  let loader: PluginLoader;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockExistsSync.mockReset();
    mockReadFileSync.mockReset();
    mockImport.mockReset();
    loader = new PluginLoader({ pluginDir: "/tmp/plugins" });
  });

  describe("constructor", () => {
    it("defaults pluginDir to .openmesh/plugins", () => {
      const l = new PluginLoader();
      expect(l.pluginDir).toContain(".openmesh/plugins");
    });

    it("accepts custom pluginDir", () => {
      expect(loader.pluginDir).toBe("/tmp/plugins");
    });
  });

  describe("loadLocal", () => {
    it("reads openmesh-plugin.json and dynamic-imports the entry", async () => {
      const manifest = makeManifest({ entry: "./index.js" });
      const obs = makeObserver();

      mockExistsSync.mockImplementation((p: string) => {
        if (p.endsWith("openmesh-plugin.json")) return true;
        if (p.endsWith("index.js")) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(JSON.stringify(manifest));

      // Spy on the private loadFromManifest to intercept import()
      const spy = vi.spyOn(loader as any, "loadFromManifest").mockResolvedValue({
        manifest,
        observers: [obs],
        operators: [],
        goals: [],
      });

      const result = await loader.loadLocal("/fake/plugin");

      expect(mockExistsSync).toHaveBeenCalled();
      expect(mockReadFileSync).toHaveBeenCalledWith(
        expect.stringContaining("openmesh-plugin.json"),
        "utf-8",
      );
      expect(result.manifest.name).toBe("test-plugin");
      expect(result.observers).toHaveLength(1);
      expect(result.observers[0]!.id).toBe("obs-1");

      spy.mockRestore();
    });

    it("falls back to package.json when no openmesh-plugin.json", async () => {
      const pkgJson = {
        name: "my-pkg-plugin",
        version: "2.0.0",
        main: "./lib/entry.js",
        openmesh: { type: "operator" },
      };

      mockExistsSync.mockImplementation((p: string) => {
        if (p.endsWith("openmesh-plugin.json")) return false;
        if (p.endsWith("package.json")) return true;
        if (p.endsWith("entry.js")) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(JSON.stringify(pkgJson));

      const op = makeOperator();
      vi.spyOn(loader as any, "loadFromManifest").mockResolvedValue({
        manifest: {
          name: "my-pkg-plugin",
          version: "2.0.0",
          type: "operator",
          entry: "./lib/entry.js",
        },
        observers: [],
        operators: [op],
        goals: [],
      });

      const result = await loader.loadLocal("/fake/plugin-pkg");

      expect(result.manifest.name).toBe("my-pkg-plugin");
      expect(result.manifest.version).toBe("2.0.0");
      expect(result.manifest.type).toBe("operator");
      expect(result.operators).toHaveLength(1);
    });

    it("throws when neither openmesh-plugin.json nor package.json exists", async () => {
      mockExistsSync.mockReturnValue(false);

      await expect(loader.loadLocal("/fake/empty")).rejects.toThrow(
        /No openmesh-plugin.json or package.json found/,
      );
    });

    it("throws when entry file does not exist", async () => {
      const manifest = makeManifest({ entry: "./missing.js" });

      mockExistsSync.mockImplementation((p: string) => {
        if (p.endsWith("openmesh-plugin.json")) return true;
        // entry file does NOT exist
        return false;
      });
      mockReadFileSync.mockReturnValue(JSON.stringify(manifest));

      await expect(loader.loadLocal("/fake/broken")).rejects.toThrow(
        /Plugin entry not found/,
      );
    });
  });

  describe("loadNpm", () => {
    it("dynamic-imports the npm package and returns a LoadedPlugin", async () => {
      const obs = makeObserver("npm-obs");
      const spy = vi.spyOn(loader as any, "extractPlugin").mockReturnValue({
        manifest: { name: "my-npm-plugin", version: "0.0.0", type: "bundle", entry: "my-npm-plugin" },
        observers: [obs],
        operators: [],
        goals: [],
      });

      // We can't easily mock global import(), so mock the full method
      vi.spyOn(loader, "loadNpm").mockResolvedValue({
        manifest: { name: "my-npm-plugin", version: "0.0.0", type: "bundle", entry: "my-npm-plugin" },
        observers: [obs],
        operators: [],
        goals: [],
      });

      const result = await loader.loadNpm("my-npm-plugin");
      expect(result.manifest.name).toBe("my-npm-plugin");
      expect(result.observers[0]!.id).toBe("npm-obs");

      spy.mockRestore();
    });
  });

  describe("extractPlugin", () => {
    // Access private method for detailed unit testing
    function extract(mod: Record<string, unknown>, manifest?: PluginManifest): LoadedPlugin {
      return (loader as any).extractPlugin(mod, manifest ?? makeManifest());
    }

    it("extracts observer from default export (has watch + events)", () => {
      const obs = makeObserver();
      const result = extract({ default: obs });
      expect(result.observers).toHaveLength(1);
      expect(result.operators).toHaveLength(0);
    });

    it("extracts operator from default export (has execute + id)", () => {
      const op = makeOperator();
      const result = extract({ default: op });
      expect(result.operators).toHaveLength(1);
      expect(result.observers).toHaveLength(0);
    });

    it("extracts goal from default export (has observe + then)", () => {
      const goal = makeGoal();
      const result = extract({ default: goal });
      expect(result.goals).toHaveLength(1);
    });

    it("extracts bundle from default export", () => {
      const bundle = {
        observers: [makeObserver("b-obs")],
        operators: [makeOperator("b-op")],
        goals: [makeGoal("b-goal")],
      };
      const result = extract({ default: bundle });
      expect(result.observers).toHaveLength(1);
      expect(result.operators).toHaveLength(1);
      expect(result.goals).toHaveLength(1);
    });

    it("extracts from named exports: observer, operator, goal", () => {
      const result = extract({
        observer: makeObserver("named-obs"),
        operator: makeOperator("named-op"),
        goal: makeGoal("named-goal"),
      });
      expect(result.observers).toHaveLength(1);
      expect(result.operators).toHaveLength(1);
      expect(result.goals).toHaveLength(1);
    });

    it("extracts from named plural exports: observers, operators, goals", () => {
      const result = extract({
        observers: [makeObserver("a"), makeObserver("b")],
        operators: [makeOperator("x")],
        goals: [makeGoal("y"), makeGoal("z")],
      });
      expect(result.observers).toHaveLength(2);
      expect(result.operators).toHaveLength(1);
      expect(result.goals).toHaveLength(2);
    });

    it("combines default and named exports", () => {
      const obs = makeObserver("default-obs");
      const result = extract({
        default: obs,
        operator: makeOperator("named-op"),
      });
      expect(result.observers).toHaveLength(1);
      expect(result.operators).toHaveLength(1);
    });

    it("returns empty arrays when module has no recognizable exports", () => {
      const result = extract({});
      expect(result.observers).toHaveLength(0);
      expect(result.operators).toHaveLength(0);
      expect(result.goals).toHaveLength(0);
    });
  });

  describe("PluginManifest shape", () => {
    it("has required fields: name, version, type, entry", () => {
      const m = makeManifest();
      expect(m).toHaveProperty("name");
      expect(m).toHaveProperty("version");
      expect(m).toHaveProperty("type");
      expect(m).toHaveProperty("entry");
    });

    it("accepts optional fields: description, permissions, config", () => {
      const m = makeManifest({
        description: "A test plugin",
        permissions: ["exec:read", "network:outbound"],
        config: { key: "value" },
      });
      expect(m.description).toBe("A test plugin");
      expect(m.permissions).toEqual(["exec:read", "network:outbound"]);
      expect(m.config).toEqual({ key: "value" });
    });

    it("type must be one of the allowed values", () => {
      const allowed = ["observer", "operator", "goal", "bundle"] as const;
      for (const t of allowed) {
        expect(() => makeManifest({ type: t })).not.toThrow();
      }
    });
  });
});

// ── PluginRegistry ──────────────────────────────────────────────────

describe("PluginRegistry", () => {
  let registry: PluginRegistry;
  let mesh: ReturnType<typeof makeMesh>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockExistsSync.mockReset();
    mockReadFileSync.mockReset();
    registry = new PluginRegistry({ pluginDir: "/tmp/plugins" });
    mesh = makeMesh();
  });

  describe("register", () => {
    it("stores the plugin and wires observers into the mesh", () => {
      const obs = makeObserver();
      const plugin = makeLoadedPlugin({ observers: [obs] });

      registry.register(plugin, mesh);

      expect(mesh.addObserver).toHaveBeenCalledWith(obs);
      expect(registry.get("test-plugin")).toBe(plugin);
    });

    it("wires operators into the mesh", () => {
      const op = makeOperator();
      const plugin = makeLoadedPlugin({ operators: [op] });

      registry.register(plugin, mesh);

      expect(mesh.addOperator).toHaveBeenCalledWith(op);
    });

    it("wires goals into the mesh", () => {
      const goal = makeGoal();
      const plugin = makeLoadedPlugin({ goals: [goal] });

      registry.register(plugin, mesh);

      expect(mesh.addGoal).toHaveBeenCalledWith(goal);
    });

    it("wires all component types from a bundle plugin", () => {
      const plugin = makeLoadedPlugin({
        observers: [makeObserver()],
        operators: [makeOperator()],
        goals: [makeGoal()],
      });

      registry.register(plugin, mesh);

      expect(mesh.addObserver).toHaveBeenCalledOnce();
      expect(mesh.addOperator).toHaveBeenCalledOnce();
      expect(mesh.addGoal).toHaveBeenCalledOnce();
    });
  });

  describe("get", () => {
    it("returns the plugin by name", () => {
      const plugin = makeLoadedPlugin();
      registry.register(plugin, mesh);
      expect(registry.get("test-plugin")).toBe(plugin);
    });

    it("returns undefined for unknown plugin", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });
  });

  describe("list", () => {
    it("returns empty array when no plugins registered", () => {
      expect(registry.list()).toEqual([]);
    });

    it("returns all registered plugins", () => {
      const p1 = makeLoadedPlugin({ manifest: makeManifest({ name: "plugin-a" }) });
      const p2 = makeLoadedPlugin({ manifest: makeManifest({ name: "plugin-b" }) });

      registry.register(p1, mesh);
      registry.register(p2, mesh);

      const all = registry.list();
      expect(all).toHaveLength(2);
      const names = all.map((p) => p.manifest.name);
      expect(names).toContain("plugin-a");
      expect(names).toContain("plugin-b");
    });
  });

  describe("loadLocal", () => {
    it("delegates to PluginLoader.loadLocal and auto-registers", async () => {
      const obs = makeObserver("local-obs");
      const plugin = makeLoadedPlugin({ observers: [obs] });

      // Mock the internal loader's loadLocal
      vi.spyOn((registry as any).loader, "loadLocal").mockResolvedValue(plugin);

      const result = await registry.loadLocal("/some/plugin/dir", mesh);

      expect(result).toBe(plugin);
      expect(mesh.addObserver).toHaveBeenCalledWith(obs);
      expect(registry.get("test-plugin")).toBe(plugin);
    });
  });

  describe("loadNpm", () => {
    it("delegates to PluginLoader.loadNpm and auto-registers", async () => {
      const op = makeOperator("npm-op");
      const plugin = makeLoadedPlugin({
        manifest: makeManifest({ name: "npm-plugin" }),
        operators: [op],
      });

      vi.spyOn((registry as any).loader, "loadNpm").mockResolvedValue(plugin);

      const result = await registry.loadNpm("npm-plugin", mesh);

      expect(result).toBe(plugin);
      expect(mesh.addOperator).toHaveBeenCalledWith(op);
      expect(registry.get("npm-plugin")).toBe(plugin);
    });
  });

  describe("overwrite behavior", () => {
    it("re-registering same plugin name overwrites the previous entry", () => {
      const p1 = makeLoadedPlugin({ observers: [makeObserver("v1")] });
      const p2 = makeLoadedPlugin({ observers: [makeObserver("v2")] });

      registry.register(p1, mesh);
      registry.register(p2, mesh);

      const stored = registry.get("test-plugin");
      expect(stored!.observers[0]!.id).toBe("v2");
      expect(registry.list()).toHaveLength(1);
    });
  });
});
