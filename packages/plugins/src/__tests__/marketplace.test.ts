import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PluginMarketplace } from "../marketplace.js";

// ── Mock data ────────────────────────────────────────────────────────

const searchResponse = {
  objects: [
    {
      package: {
        name: "openmesh-plugin-metrics",
        version: "2.1.0",
        description: "Metrics observer for openmesh",
        keywords: ["openmesh-plugin", "openmesh-observer"],
        author: { name: "Alice" },
        links: {
          repository: "https://github.com/alice/openmesh-plugin-metrics",
          homepage: "https://metrics.example.com",
        },
      },
    },
    {
      package: {
        name: "openmesh-plugin-transform",
        version: "1.0.0",
        description: "Transform operator",
        keywords: ["openmesh-plugin", "openmesh-operator"],
        author: { name: "Bob" },
        links: {},
      },
    },
  ],
};

const packageInfoResponse = {
  name: "openmesh-plugin-metrics",
  description: "Metrics observer for openmesh",
  "dist-tags": { latest: "2.1.0" },
  versions: {
    "2.1.0": {
      description: "Metrics observer for openmesh",
      keywords: ["openmesh-plugin", "openmesh-observer"],
    },
  },
  author: { name: "Alice" },
  repository: { url: "https://github.com/alice/openmesh-plugin-metrics" },
  homepage: "https://metrics.example.com",
  keywords: ["openmesh-plugin", "openmesh-observer"],
};

// ── Tests ────────────────────────────────────────────────────────────

describe("PluginMarketplace", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetchOk(data: unknown) {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => data,
    });
  }

  function mockFetch404() {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });
  }

  // ── search ─────────────────────────────────────────────────────────

  it("search returns results from npm registry", async () => {
    mockFetchOk(searchResponse);
    const mp = new PluginMarketplace();
    const results = await mp.search("metrics");

    expect(results).toHaveLength(2);
    expect(results[0]!.name).toBe("openmesh-plugin-metrics");
    expect(results[0]!.type).toBe("observer");
    expect(results[1]!.name).toBe("openmesh-plugin-transform");
    expect(results[1]!.type).toBe("operator");
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]![0]).toContain("metrics");
  });

  it("search with type filter returns only matching type", async () => {
    mockFetchOk(searchResponse);
    const mp = new PluginMarketplace();
    const results = await mp.search("plugin", { type: "operator" });

    expect(results).toHaveLength(1);
    expect(results[0]!.type).toBe("operator");
  });

  // ── getInfo ────────────────────────────────────────────────────────

  it("get info for known plugin", async () => {
    mockFetchOk(packageInfoResponse);
    const mp = new PluginMarketplace();
    const info = await mp.getInfo("openmesh-plugin-metrics");

    expect(info).not.toBeNull();
    expect(info!.name).toBe("openmesh-plugin-metrics");
    expect(info!.version).toBe("2.1.0");
    expect(info!.type).toBe("observer");
    expect(info!.author).toBe("Alice");
  });

  it("get info for unknown plugin returns null", async () => {
    mockFetch404();
    const mp = new PluginMarketplace();
    const info = await mp.getInfo("does-not-exist");

    expect(info).toBeNull();
  });

  // ── listFeatured ───────────────────────────────────────────────────

  it("list featured plugins", async () => {
    mockFetchOk(searchResponse);
    const mp = new PluginMarketplace();
    const featured = await mp.listFeatured(5);

    expect(featured).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]![0]).toContain("size=5");
  });

  // ── checkUpdates ───────────────────────────────────────────────────

  it("check updates finds available updates", async () => {
    mockFetchOk({
      name: "openmesh-plugin-metrics",
      "dist-tags": { latest: "3.0.0" },
    });
    const mp = new PluginMarketplace();
    const updates = await mp.checkUpdates([
      { name: "openmesh-plugin-metrics", version: "2.1.0" },
    ]);

    expect(updates).toEqual([
      { name: "openmesh-plugin-metrics", current: "2.1.0", latest: "3.0.0" },
    ]);
  });

  it("check updates when all up to date", async () => {
    mockFetchOk({
      name: "openmesh-plugin-metrics",
      "dist-tags": { latest: "2.1.0" },
    });
    const mp = new PluginMarketplace();
    const updates = await mp.checkUpdates([
      { name: "openmesh-plugin-metrics", version: "2.1.0" },
    ]);

    expect(updates).toEqual([]);
  });

  // ── caching ────────────────────────────────────────────────────────

  it("results are cached (second call does not re-fetch)", async () => {
    mockFetchOk(searchResponse);
    const mp = new PluginMarketplace();

    await mp.search("metrics");
    await mp.search("metrics");

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("cache expires after TTL", async () => {
    mockFetchOk(searchResponse);
    mockFetchOk(searchResponse);

    const mp = new PluginMarketplace({ cacheTtlMs: 0 });

    await mp.search("metrics");
    // TTL=0 means cache is already expired on next call
    await mp.search("metrics");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
