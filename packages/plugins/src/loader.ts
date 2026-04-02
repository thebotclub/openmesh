/**
 * PluginLoader — discovers and loads plugins from npm or local paths.
 *
 * Uses dynamic import() to load ESM modules at runtime.
 * Validates plugin manifests before loading.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Observer, Operator, Goal } from "@openmesh/core";

export interface PluginManifest {
  name: string;
  version: string;
  type: "observer" | "operator" | "goal" | "bundle";
  entry: string;
  description?: string;
  permissions?: string[];
  config?: Record<string, unknown>;
  dependencies?: Record<string, string>; // name → semver range
  hooks?: Array<{
    hook: string;
    handler: string; // exported function name in the entry module
    priority?: number;
  }>;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  observers: Observer[];
  operators: Operator[];
  goals: Goal[];
  hookHandlers?: Array<{
    hook: string;
    handler: (...args: any[]) => any;
    priority?: number;
  }>;
}

interface PluginExports {
  default?: Observer | Operator | Goal | PluginBundle;
  observer?: Observer;
  observers?: Observer[];
  operator?: Operator;
  operators?: Operator[];
  goal?: Goal;
  goals?: Goal[];
}

interface PluginBundle {
  observers?: Observer[];
  operators?: Operator[];
  goals?: Goal[];
}

export class PluginLoader {
  readonly pluginDir: string;

  constructor(options?: { pluginDir?: string }) {
    this.pluginDir = options?.pluginDir ?? resolve(".openmesh", "plugins");
  }

  /**
   * Load a plugin from a local directory.
   *
   * @example
   * ```ts
   * const plugin = await loader.loadLocal("./plugins/my-observer");
   * mesh.addObserver(plugin.observers[0]);
   * ```
   */
  async loadLocal(dir: string): Promise<LoadedPlugin> {
    const absDir = resolve(dir);
    const manifestPath = join(absDir, "openmesh-plugin.json");

    let manifest: PluginManifest;
    if (existsSync(manifestPath)) {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as PluginManifest;
    } else {
      // Try package.json fallback
      const pkgPath = join(absDir, "package.json");
      if (!existsSync(pkgPath)) {
        throw new Error(`No openmesh-plugin.json or package.json found in ${absDir}`);
      }
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
      manifest = {
        name: pkg["name"] as string ?? "unknown",
        version: pkg["version"] as string ?? "0.0.0",
        type: (pkg["openmesh"]as Record<string, unknown>)?.["type"] as PluginManifest["type"] ?? "bundle",
        entry: pkg["main"] as string ?? "./dist/index.js",
      };
    }

    return this.loadFromManifest(absDir, manifest);
  }

  /**
   * Load a plugin from npm.
   * Resolves the package in node_modules via import().
   *
   * @example
   * ```ts
   * const plugin = await loader.loadNpm("openmesh-plugin-datadog");
   * ```
   */
  async loadNpm(packageName: string): Promise<LoadedPlugin> {
    const mod = (await import(packageName)) as PluginExports;
    return this.extractPlugin(mod, {
      name: packageName,
      version: "0.0.0",
      type: "bundle",
      entry: packageName,
    });
  }

  private async loadFromManifest(baseDir: string, manifest: PluginManifest): Promise<LoadedPlugin> {
    const entryPath = resolve(baseDir, manifest.entry);
    if (!existsSync(entryPath)) {
      throw new Error(`Plugin entry not found: ${entryPath}`);
    }

    const mod = (await import(entryPath)) as PluginExports;
    return this.extractPlugin(mod, manifest);
  }

  private extractPlugin(mod: PluginExports, manifest: PluginManifest): LoadedPlugin {
    const hookHandlers: NonNullable<LoadedPlugin["hookHandlers"]> = [];
    if (manifest.hooks) {
      for (const hookDef of manifest.hooks) {
        const fn = (mod as Record<string, unknown>)[hookDef.handler];
        if (typeof fn === "function") {
          hookHandlers.push({
            hook: hookDef.hook,
            handler: fn as (...args: any[]) => any,
            priority: hookDef.priority,
          });
        }
      }
    }

    const plugin: LoadedPlugin = {
      manifest,
      observers: [],
      operators: [],
      goals: [],
      ...(hookHandlers.length > 0 ? { hookHandlers } : {}),
    };

    // Handle default export
    if (mod.default) {
      const def = mod.default;
      if ("watch" in def && "events" in def) {
        plugin.observers.push(def as Observer);
      } else if ("execute" in def && "id" in def) {
        plugin.operators.push(def as Operator);
      } else if ("observe" in def && "then" in def) {
        plugin.goals.push(def as Goal);
      } else if ("observers" in def || "operators" in def || "goals" in def) {
        const bundle = def as PluginBundle;
        plugin.observers.push(...(bundle.observers ?? []));
        plugin.operators.push(...(bundle.operators ?? []));
        plugin.goals.push(...(bundle.goals ?? []));
      }
    }

    // Handle named exports
    if (mod.observer) plugin.observers.push(mod.observer);
    if (mod.observers) plugin.observers.push(...mod.observers);
    if (mod.operator) plugin.operators.push(mod.operator);
    if (mod.operators) plugin.operators.push(...mod.operators);
    if (mod.goal) plugin.goals.push(mod.goal);
    if (mod.goals) plugin.goals.push(...mod.goals);

    return plugin;
  }
}
