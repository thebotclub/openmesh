import { describe, it, expect, vi, beforeEach } from "vitest";
import { DependencyResolver, satisfies } from "../resolver.js";
import type { PluginManifest } from "../loader.js";
import type { PluginLoader } from "../loader.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeManifest(
  name: string,
  version: string,
  deps?: Record<string, string>,
): PluginManifest {
  return {
    name,
    version,
    type: "bundle",
    entry: "./dist/index.js",
    dependencies: deps,
  };
}

function createMockLoader(
  available: Map<string, PluginManifest>,
): PluginLoader {
  return {
    pluginDir: "/plugins",
    loadLocal: vi.fn(async (dir: string) => {
      const name = dir.split("/").pop()!;
      const manifest = available.get(name);
      if (!manifest) throw new Error(`Not found: ${dir}`);
      return { manifest, observers: [], operators: [], goals: [] };
    }),
    loadNpm: vi.fn(),
  } as unknown as PluginLoader;
}

// ── satisfies() ──────────────────────────────────────────────────────

describe("satisfies (semver)", () => {
  it("matches exact version", () => {
    expect(satisfies("1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("1.2.4", "1.2.3")).toBe(false);
  });

  it("matches = prefix", () => {
    expect(satisfies("2.0.0", "=2.0.0")).toBe(true);
    expect(satisfies("2.0.1", "=2.0.0")).toBe(false);
  });

  it("matches ^ (caret) range", () => {
    expect(satisfies("1.2.3", "^1.2.3")).toBe(true);
    expect(satisfies("1.9.0", "^1.2.3")).toBe(true);
    expect(satisfies("2.0.0", "^1.2.3")).toBe(false);
    expect(satisfies("1.2.2", "^1.2.3")).toBe(false);
  });

  it("matches ~ (tilde) range", () => {
    expect(satisfies("1.2.3", "~1.2.3")).toBe(true);
    expect(satisfies("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
    expect(satisfies("1.2.2", "~1.2.3")).toBe(false);
  });

  it("matches >= range", () => {
    expect(satisfies("2.0.0", ">=2.0.0")).toBe(true);
    expect(satisfies("3.0.0", ">=2.0.0")).toBe(true);
    expect(satisfies("1.9.9", ">=2.0.0")).toBe(false);
  });

  it("matches > range", () => {
    expect(satisfies("2.0.1", ">2.0.0")).toBe(true);
    expect(satisfies("2.0.0", ">2.0.0")).toBe(false);
  });

  it("matches <= range", () => {
    expect(satisfies("2.0.0", "<=2.0.0")).toBe(true);
    expect(satisfies("1.0.0", "<=2.0.0")).toBe(true);
    expect(satisfies("2.0.1", "<=2.0.0")).toBe(false);
  });

  it("matches < range", () => {
    expect(satisfies("1.9.9", "<2.0.0")).toBe(true);
    expect(satisfies("2.0.0", "<2.0.0")).toBe(false);
  });

  it("returns false for invalid version strings", () => {
    expect(satisfies("abc", "^1.0.0")).toBe(false);
    expect(satisfies("1.0.0", "^abc")).toBe(false);
  });
});

// ── DependencyResolver ───────────────────────────────────────────────

describe("DependencyResolver", () => {
  let available: Map<string, PluginManifest>;

  beforeEach(() => {
    available = new Map();
  });

  // ── resolve ────────────────────────────────────────────────────────

  it("resolves plugin with no dependencies", async () => {
    const manifest = makeManifest("root", "1.0.0");
    const loader = createMockLoader(available);
    const resolver = new DependencyResolver(loader);

    const result = await resolver.resolve(manifest);
    expect(result).toEqual([]);
  });

  it("resolves plugin with satisfied dependencies", async () => {
    available.set("dep-a", makeManifest("dep-a", "1.5.0"));
    const manifest = makeManifest("root", "1.0.0", { "dep-a": "^1.0.0" });
    const loader = createMockLoader(available);
    const resolver = new DependencyResolver(loader);

    const result = await resolver.resolve(manifest);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("dep-a");
    expect(result[0]!.version).toBe("1.5.0");
  });

  // ── check ──────────────────────────────────────────────────────────

  it("detects missing dependencies", async () => {
    const manifest = makeManifest("root", "1.0.0", {
      "missing-dep": "^1.0.0",
    });
    const loader = createMockLoader(available);
    const resolver = new DependencyResolver(loader);

    const { satisfied, missing } = await resolver.check(manifest);
    expect(satisfied).toBe(false);
    expect(missing).toEqual([{ name: "missing-dep", version: "^1.0.0" }]);
  });

  it("reports satisfied when all deps are present", async () => {
    available.set("dep-a", makeManifest("dep-a", "2.0.0"));
    const manifest = makeManifest("root", "1.0.0", { "dep-a": "^2.0.0" });
    const loader = createMockLoader(available);
    const resolver = new DependencyResolver(loader);

    const { satisfied, missing } = await resolver.check(manifest);
    expect(satisfied).toBe(true);
    expect(missing).toEqual([]);
  });

  // ── getLoadOrder (topological sort) ────────────────────────────────

  it("topological sort of 3+ plugins with chain", async () => {
    const a = makeManifest("A", "1.0.0", { B: "^1.0.0" });
    const b = makeManifest("B", "1.0.0", { C: "^1.0.0" });
    const c = makeManifest("C", "1.0.0");

    const loader = createMockLoader(available);
    const resolver = new DependencyResolver(loader);
    const order = await resolver.getLoadOrder([a, b, c]);

    const names = order.map((m) => m.name);
    expect(names.indexOf("C")).toBeLessThan(names.indexOf("B"));
    expect(names.indexOf("B")).toBeLessThan(names.indexOf("A"));
  });

  it("topological sort with diamond dependency", async () => {
    // A→B, A→C, B→D, C→D
    const a = makeManifest("A", "1.0.0", { B: "^1.0.0", C: "^1.0.0" });
    const b = makeManifest("B", "1.0.0", { D: "^1.0.0" });
    const c = makeManifest("C", "1.0.0", { D: "^1.0.0" });
    const d = makeManifest("D", "1.0.0");

    const loader = createMockLoader(available);
    const resolver = new DependencyResolver(loader);
    const order = await resolver.getLoadOrder([a, b, c, d]);

    const names = order.map((m) => m.name);
    expect(names.indexOf("D")).toBeLessThan(names.indexOf("B"));
    expect(names.indexOf("D")).toBeLessThan(names.indexOf("C"));
    expect(names.indexOf("B")).toBeLessThan(names.indexOf("A"));
    expect(names.indexOf("C")).toBeLessThan(names.indexOf("A"));
  });

  // ── detectCycles ───────────────────────────────────────────────────

  it("detects circular dependency A→B→A", () => {
    const a = makeManifest("A", "1.0.0", { B: "^1.0.0" });
    const b = makeManifest("B", "1.0.0", { A: "^1.0.0" });

    const loader = createMockLoader(available);
    const resolver = new DependencyResolver(loader);
    const cycles = resolver.detectCycles([a, b]);

    expect(cycles).not.toBeNull();
    expect(cycles!.length).toBeGreaterThanOrEqual(1);
    // The cycle chain should contain both A and B
    const flat = cycles!.flat();
    expect(flat).toContain("A");
    expect(flat).toContain("B");
  });

  it("detects longer cycle A→B→C→A", () => {
    const a = makeManifest("A", "1.0.0", { B: "^1.0.0" });
    const b = makeManifest("B", "1.0.0", { C: "^1.0.0" });
    const c = makeManifest("C", "1.0.0", { A: "^1.0.0" });

    const loader = createMockLoader(available);
    const resolver = new DependencyResolver(loader);
    const cycles = resolver.detectCycles([a, b, c]);

    expect(cycles).not.toBeNull();
    const flat = cycles!.flat();
    expect(flat).toContain("A");
    expect(flat).toContain("B");
    expect(flat).toContain("C");
  });

  it("getLoadOrder throws on circular dependency", async () => {
    const a = makeManifest("A", "1.0.0", { B: "^1.0.0" });
    const b = makeManifest("B", "1.0.0", { A: "^1.0.0" });

    const loader = createMockLoader(available);
    const resolver = new DependencyResolver(loader);

    await expect(resolver.getLoadOrder([a, b])).rejects.toThrow(
      /Circular dependency detected/,
    );
  });

  it("returns null when no cycles exist", () => {
    const a = makeManifest("A", "1.0.0", { B: "^1.0.0" });
    const b = makeManifest("B", "1.0.0");

    const loader = createMockLoader(available);
    const resolver = new DependencyResolver(loader);
    expect(resolver.detectCycles([a, b])).toBeNull();
  });
});
