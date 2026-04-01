// ── Provider Types ──────────────────────────────────────────────────

/** LLM provider configuration (reuses OpenClaw's provider abstraction concept) */
export interface ProviderConfig {
  /** Provider ID (e.g., "anthropic", "openai", "ollama") */
  id: string;
  /** Display name */
  label: string;
  /** API base URL (optional, for custom endpoints) */
  baseUrl?: string;
  /** Authentication method */
  auth: ProviderAuth;
  /** Default model for this provider */
  defaultModel?: string;
}

export type ProviderAuth =
  | { method: "api-key"; envVar: string }
  | { method: "oauth"; clientId: string; scopes: string[] }
  | { method: "none" };
