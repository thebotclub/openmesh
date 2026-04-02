/**
 * DependencyResolver — resolves plugin dependency graphs,
 * checks satisfaction, produces load order via topological sort,
 * and detects circular dependencies.
 */

import type { PluginLoader, PluginManifest } from "./loader.js";

// ── Public types ─────────────────────────────────────────────────────

export interface PluginDependency {
  name: string;
  version: string; // semver range (e.g., "^1.0.0", ">=2.0.0")
}

export interface ResolvedPlugin {
  name: string;
  version: string;
  path: string;
  dependencies: ResolvedPlugin[];
}

// ── Semver helpers (no external deps) ────────────────────────────────

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

function parseSemVer(v: string): SemVer | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Check whether `version` satisfies the given `range`.
 *
 * Supported range prefixes: `^`, `~`, `>=`, `>`, `<=`, `<`, `=`.
 * A bare version string (no prefix) is treated as an exact match.
 */
export function satisfies(version: string, range: string): boolean {
  const ver = parseSemVer(version);
  if (!ver) return false;

  const trimmed = range.trim();

  // Caret range: ^1.2.3 → >=1.2.3 <2.0.0
  if (trimmed.startsWith("^")) {
    const bound = parseSemVer(trimmed.slice(1));
    if (!bound) return false;
    const upper: SemVer = { major: bound.major + 1, minor: 0, patch: 0 };
    return compareSemVer(ver, bound) >= 0 && compareSemVer(ver, upper) < 0;
  }

  // Tilde range: ~1.2.3 → >=1.2.3 <1.3.0
  if (trimmed.startsWith("~")) {
    const bound = parseSemVer(trimmed.slice(1));
    if (!bound) return false;
    const upper: SemVer = { major: bound.major, minor: bound.minor + 1, patch: 0 };
    return compareSemVer(ver, bound) >= 0 && compareSemVer(ver, upper) < 0;
  }

  // Comparison operators
  if (trimmed.startsWith(">=")) {
    const bound = parseSemVer(trimmed.slice(2));
    return bound ? compareSemVer(ver, bound) >= 0 : false;
  }
  if (trimmed.startsWith(">") && !trimmed.startsWith(">=")) {
    const bound = parseSemVer(trimmed.slice(1));
    return bound ? compareSemVer(ver, bound) > 0 : false;
  }
  if (trimmed.startsWith("<=")) {
    const bound = parseSemVer(trimmed.slice(2));
    return bound ? compareSemVer(ver, bound) <= 0 : false;
  }
  if (trimmed.startsWith("<") && !trimmed.startsWith("<=")) {
    const bound = parseSemVer(trimmed.slice(1));
    return bound ? compareSemVer(ver, bound) < 0 : false;
  }
  if (trimmed.startsWith("=")) {
    const bound = parseSemVer(trimmed.slice(1));
    return bound ? compareSemVer(ver, bound) === 0 : false;
  }

  // Exact match (no prefix)
  const bound = parseSemVer(trimmed);
  return bound ? compareSemVer(ver, bound) === 0 : false;
}

// ── DependencyResolver ───────────────────────────────────────────────

export class DependencyResolver {
  constructor(private loader: PluginLoader) {}

  /**
   * Resolve all dependencies for a plugin recursively.
   * Each resolved entry points at the directory inside the loader's pluginDir.
   */
  async resolve(manifest: PluginManifest): Promise<ResolvedPlugin[]> {
    const deps = manifest.dependencies ?? {};
    const resolved: ResolvedPlugin[] = [];

    for (const [name, range] of Object.entries(deps)) {
      const depManifest = await this.findManifest(name);
      if (!depManifest) {
        throw new Error(
          `Dependency "${name}@${range}" required by "${manifest.name}" not found`,
        );
      }
      if (!satisfies(depManifest.version, range)) {
        throw new Error(
          `Dependency "${name}" version ${depManifest.version} does not satisfy "${range}" (required by "${manifest.name}")`,
        );
      }

      const childDeps = await this.resolve(depManifest);
      resolved.push({
        name: depManifest.name,
        version: depManifest.version,
        path: this.pluginPath(name),
        dependencies: childDeps,
      });
    }

    return resolved;
  }

  /**
   * Check whether every declared dependency of `manifest` is available
   * and version-compatible.
   */
  async check(
    manifest: PluginManifest,
  ): Promise<{ satisfied: boolean; missing: PluginDependency[] }> {
    const deps = manifest.dependencies ?? {};
    const missing: PluginDependency[] = [];

    for (const [name, range] of Object.entries(deps)) {
      const depManifest = await this.findManifest(name);
      if (!depManifest || !satisfies(depManifest.version, range)) {
        missing.push({ name, version: range });
      }
    }

    return { satisfied: missing.length === 0, missing };
  }

  /**
   * Return manifests in a safe load order (topological sort via DFS).
   * Throws if a cycle is detected.
   */
  async getLoadOrder(manifests: PluginManifest[]): Promise<PluginManifest[]> {
    const cycles = this.detectCycles(manifests);
    if (cycles) {
      const chain = cycles[0]!.join(" → ");
      throw new Error(`Circular dependency detected: ${chain}`);
    }

    const byName = new Map(manifests.map((m) => [m.name, m]));
    const order: PluginManifest[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (m: PluginManifest) => {
      if (visited.has(m.name)) return;
      if (visiting.has(m.name)) return; // cycle already checked above
      visiting.add(m.name);

      for (const depName of Object.keys(m.dependencies ?? {})) {
        const dep = byName.get(depName);
        if (dep) visit(dep);
      }

      visiting.delete(m.name);
      visited.add(m.name);
      order.push(m);
    };

    for (const m of manifests) visit(m);
    return order;
  }

  /**
   * Detect circular dependencies among a set of manifests.
   * Returns an array of cycle chains, or `null` if none exist.
   */
  detectCycles(manifests: PluginManifest[]): string[][] | null {
    const byName = new Map(manifests.map((m) => [m.name, m]));
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const cycles: string[][] = [];

    const dfs = (name: string, path: string[]) => {
      if (visited.has(name)) return;

      if (visiting.has(name)) {
        // Extract the cycle portion from path
        const idx = path.indexOf(name);
        cycles.push([...path.slice(idx), name]);
        return;
      }

      visiting.add(name);
      path.push(name);

      const m = byName.get(name);
      if (m) {
        for (const depName of Object.keys(m.dependencies ?? {})) {
          if (byName.has(depName)) {
            dfs(depName, path);
          }
        }
      }

      path.pop();
      visiting.delete(name);
      visited.add(name);
    };

    for (const m of manifests) {
      dfs(m.name, []);
    }

    return cycles.length > 0 ? cycles : null;
  }

  // ── Private helpers ────────────────────────────────────────────────

  private pluginPath(name: string): string {
    return `${this.loader.pluginDir}/${name}`;
  }

  private async findManifest(name: string): Promise<PluginManifest | null> {
    try {
      const loaded = await this.loader.loadLocal(this.pluginPath(name));
      return loaded.manifest;
    } catch {
      return null;
    }
  }
}
