/**
 * PluginMarketplace — discover, search, and check updates for openmesh
 * plugins via the npm registry.
 */

// ── Public types ─────────────────────────────────────────────────────

export interface MarketplaceEntry {
  name: string;
  version: string;
  description: string;
  type: "observer" | "operator" | "goal" | "bundle";
  author?: string;
  downloads?: number;
  tags?: string[];
  repository?: string;
  homepage?: string;
}

export interface MarketplaceConfig {
  /** Base URL for the npm registry. Default: `https://registry.npmjs.org` */
  registryUrl?: string;
  /** Custom search endpoint. Default: `${registryUrl}/-/v1/search` */
  searchEndpoint?: string;
  /** Local cache directory (currently unused — in-memory cache). */
  cacheDir?: string;
  /** Cache TTL in milliseconds. Default: 3 600 000 (1 hour). */
  cacheTtlMs?: number;
}

// ── npm response shapes ──────────────────────────────────────────────

interface NpmSearchResult {
  objects: Array<{
    package: {
      name: string;
      version: string;
      description?: string;
      keywords?: string[];
      author?: { name?: string };
      links?: { repository?: string; homepage?: string };
    };
  }>;
}

interface NpmPackageInfo {
  name: string;
  "dist-tags"?: { latest?: string };
  versions?: Record<string, { description?: string; keywords?: string[] }>;
  description?: string;
  keywords?: string[];
  author?: { name?: string } | string;
  repository?: { url?: string } | string;
  homepage?: string;
}

// ── Cache helpers ────────────────────────────────────────────────────

interface CacheItem<T> {
  data: T;
  expiresAt: number;
}

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_TTL_MS = 3_600_000; // 1 hour

// ── PluginMarketplace ────────────────────────────────────────────────

export class PluginMarketplace {
  private registryUrl: string;
  private searchEndpoint: string;
  private cacheTtlMs: number;
  private cache = new Map<string, CacheItem<unknown>>();

  constructor(config?: MarketplaceConfig) {
    this.registryUrl = (config?.registryUrl ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
    this.searchEndpoint =
      config?.searchEndpoint ?? `${this.registryUrl}/-/v1/search`;
    this.cacheTtlMs = config?.cacheTtlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Search for openmesh plugins matching `query`.
   */
  async search(
    query: string,
    options?: { limit?: number; type?: string },
  ): Promise<MarketplaceEntry[]> {
    const limit = options?.limit ?? 20;
    const url = `${this.searchEndpoint}?text=openmesh-plugin+${encodeURIComponent(query)}&size=${limit}`;

    const data = await this.cachedFetch<NpmSearchResult>(url);
    let entries = data.objects.map((o) => this.searchHitToEntry(o.package));

    if (options?.type) {
      entries = entries.filter((e) => e.type === options.type);
    }

    return entries;
  }

  /**
   * Get detailed info for a specific plugin by name.
   */
  async getInfo(name: string): Promise<MarketplaceEntry | null> {
    const url = `${this.registryUrl}/${encodeURIComponent(name)}`;

    try {
      const data = await this.cachedFetch<NpmPackageInfo>(url);
      return this.packageInfoToEntry(data);
    } catch {
      return null;
    }
  }

  /**
   * List featured / popular plugins (keyword search for "openmesh-plugin").
   */
  async listFeatured(limit = 10): Promise<MarketplaceEntry[]> {
    const url = `${this.searchEndpoint}?text=openmesh-plugin&size=${limit}`;
    const data = await this.cachedFetch<NpmSearchResult>(url);
    return data.objects.map((o) => this.searchHitToEntry(o.package));
  }

  /**
   * Check which installed plugins have newer versions available.
   */
  async checkUpdates(
    installed: Array<{ name: string; version: string }>,
  ): Promise<Array<{ name: string; current: string; latest: string }>> {
    const updates: Array<{ name: string; current: string; latest: string }> = [];

    for (const pkg of installed) {
      const url = `${this.registryUrl}/${encodeURIComponent(pkg.name)}`;
      try {
        const data = await this.cachedFetch<NpmPackageInfo>(url);
        const latest = data["dist-tags"]?.latest;
        if (latest && latest !== pkg.version) {
          updates.push({ name: pkg.name, current: pkg.version, latest });
        }
      } catch {
        // Package not found on registry — skip silently
      }
    }

    return updates;
  }

  // ── Private helpers ────────────────────────────────────────────────

  private async cachedFetch<T>(url: string): Promise<T> {
    const cached = this.cache.get(url) as CacheItem<T> | undefined;
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Registry request failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as T;

    this.cache.set(url, { data, expiresAt: Date.now() + this.cacheTtlMs });
    return data;
  }

  private searchHitToEntry(pkg: NpmSearchResult["objects"][number]["package"]): MarketplaceEntry {
    return {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description ?? "",
      type: this.inferType(pkg.keywords),
      author: pkg.author?.name,
      tags: pkg.keywords,
      repository: pkg.links?.repository,
      homepage: pkg.links?.homepage,
    };
  }

  private packageInfoToEntry(pkg: NpmPackageInfo): MarketplaceEntry {
    const latest = pkg["dist-tags"]?.latest;
    const latestMeta = latest ? pkg.versions?.[latest] : undefined;

    return {
      name: pkg.name,
      version: latest ?? "0.0.0",
      description: latestMeta?.description ?? pkg.description ?? "",
      type: this.inferType(latestMeta?.keywords ?? pkg.keywords),
      author:
        typeof pkg.author === "string" ? pkg.author : pkg.author?.name,
      tags: latestMeta?.keywords ?? pkg.keywords,
      repository:
        typeof pkg.repository === "string"
          ? pkg.repository
          : pkg.repository?.url,
      homepage: pkg.homepage,
    };
  }

  private inferType(
    keywords?: string[],
  ): "observer" | "operator" | "goal" | "bundle" {
    if (!keywords) return "bundle";
    if (keywords.includes("openmesh-observer")) return "observer";
    if (keywords.includes("openmesh-operator")) return "operator";
    if (keywords.includes("openmesh-goal")) return "goal";
    return "bundle";
  }
}
