/**
 * @openmesh/plugins — Dynamic plugin loading system.
 *
 * Loads observers, operators, and goals from:
 *   1. npm packages (e.g., `openmesh-plugin-datadog`)
 *   2. Local directories (e.g., `./plugins/my-operator`)
 *   3. GitHub repos (by cloning into a cache directory)
 *
 * Inspired by OpenClaw's skill/plugin system and ESLint's flat config
 * plugin loading pattern.
 *
 * Plugin Manifest (openmesh-plugin.json):
 * {
 *   "name": "my-plugin",
 *   "version": "1.0.0",
 *   "type": "operator",         // "observer" | "operator" | "goal" | "bundle"
 *   "entry": "./dist/index.js", // ESM entry point
 *   "permissions": ["exec:read", "network:outbound"]
 * }
 */

export { PluginLoader, type PluginManifest, type LoadedPlugin } from "./loader.js";
export { PluginRegistry } from "./registry.js";
export {
  DependencyResolver,
  satisfies,
  type PluginDependency,
  type ResolvedPlugin,
} from "./resolver.js";
export {
  PluginMarketplace,
  type MarketplaceEntry,
  type MarketplaceConfig,
} from "./marketplace.js";
