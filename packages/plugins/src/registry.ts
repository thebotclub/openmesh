/**
 * PluginRegistry — manages loaded plugins and wires them into the mesh.
 */

import type { Mesh } from "@openmesh/core";
import { PluginLoader, type LoadedPlugin } from "./loader.js";

export class PluginRegistry {
  private plugins = new Map<string, LoadedPlugin>();
  private loader: PluginLoader;

  constructor(options?: { pluginDir?: string }) {
    this.loader = new PluginLoader(options);
  }

  /** Load and register a local plugin */
  async loadLocal(dir: string, mesh: Mesh): Promise<LoadedPlugin> {
    const plugin = await this.loader.loadLocal(dir);
    this.register(plugin, mesh);
    return plugin;
  }

  /** Load and register an npm plugin */
  async loadNpm(packageName: string, mesh: Mesh): Promise<LoadedPlugin> {
    const plugin = await this.loader.loadNpm(packageName);
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
}
