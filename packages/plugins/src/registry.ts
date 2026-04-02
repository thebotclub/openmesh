/**
 * PluginRegistry — manages loaded plugins and wires them into the mesh.
 */

import type { Mesh } from "@openmesh/core";
import { PluginLoader, type LoadedPlugin } from "./loader.js";
import { DependencyResolver } from "./resolver.js";

export class PluginRegistry {
  private plugins = new Map<string, LoadedPlugin>();
  private loader: PluginLoader;
  private resolver: DependencyResolver;

  constructor(options?: { pluginDir?: string }) {
    this.loader = new PluginLoader(options);
    this.resolver = new DependencyResolver(this.loader);
  }

  /** Load and register a local plugin */
  async loadLocal(dir: string, mesh: Mesh): Promise<LoadedPlugin> {
    const plugin = await this.loader.loadLocal(dir);
    await this.warnMissingDeps(plugin);
    this.register(plugin, mesh);
    return plugin;
  }

  /** Load and register an npm plugin */
  async loadNpm(packageName: string, mesh: Mesh): Promise<LoadedPlugin> {
    const plugin = await this.loader.loadNpm(packageName);
    await this.warnMissingDeps(plugin);
    this.register(plugin, mesh);
    return plugin;
  }

  /**
   * Load a local plugin and all its dependencies, then register
   * everything into the mesh in dependency-safe order.
   */
  async resolveAndLoad(path: string, mesh: Mesh): Promise<LoadedPlugin> {
    const plugin = await this.loader.loadLocal(path);
    const resolved = await this.resolver.resolve(plugin.manifest);

    // Load dependencies first (they are already in tree order)
    for (const dep of resolved) {
      if (!this.plugins.has(dep.name)) {
        const depPlugin = await this.loader.loadLocal(dep.path);
        this.register(depPlugin, mesh);
      }
    }

    this.register(plugin, mesh);
    return plugin;
  }

  /** Register a loaded plugin into the mesh */
  register(plugin: LoadedPlugin, mesh: Mesh): void {
    for (const observer of plugin.observers) {
      mesh.addObserver(observer);
    }
    for (const operator of plugin.operators) {
      mesh.addOperator(operator);
    }
    for (const goal of plugin.goals) {
      mesh.addGoal(goal);
    }
    this.plugins.set(plugin.manifest.name, plugin);
  }

  /** List all loaded plugins */
  list(): LoadedPlugin[] {
    return [...this.plugins.values()];
  }

  /** Get a specific plugin */
  get(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  // ── Private ──────────────────────────────────────────────────────

  private async warnMissingDeps(plugin: LoadedPlugin): Promise<void> {
    const { satisfied, missing } = await this.resolver.check(plugin.manifest);
    if (!satisfied) {
      const list = missing.map((d) => `${d.name}@${d.version}`).join(", ");
      console.warn(
        `[openmesh] Plugin "${plugin.manifest.name}" has missing dependencies: ${list}`,
      );
    }
  }
}
