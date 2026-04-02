import { describe, it, expect, vi, beforeEach } from "vitest";
import { MeshMCPServer } from "../server.js";

function createMockMesh() {
  return {
    bus: {
      getLog: vi.fn(() => [
        { id: "e1", type: "ci.build.failed", timestamp: "2025-01-01T00:00:00Z", source: "github", payload: { repo: "acme" } },
        { id: "e2", type: "ci.build.passed", timestamp: "2025-01-01T00:01:00Z", source: "github", payload: { repo: "acme" } },
      ]),
      on: vi.fn(),
      emit: vi.fn(),
      clear: vi.fn(),
    },
    goals: {
      list: vi.fn(() => [
        {
          id: "fix-ci",
          description: "Fix CI failures",
          observe: [{ type: "ci.build.failed" }],
          then: [{ label: "analyze", operator: "llm", task: "Analyze failure" }],
        },
      ]),
      getState: vi.fn(() => ({ phase: "idle" })),
      get: vi.fn(),
    },
    operators: { list: vi.fn(() => [{ id: "llm", name: "LLM", description: "LLM operator" }]) },
    observers: { list: vi.fn(() => [{ id: "github-webhook" }]) },
    state: {
      query: vi.fn(() => [
        { seq: 1, timestamp: "2025-01-01T00:00:00Z", kind: "observation", goalId: "fix-ci" },
      ]),
      getSeq: vi.fn(() => 1),
    },
    isRunning: vi.fn(() => true),
    createEvent: vi.fn(),
    inject: vi.fn(),
  } as unknown as ConstructorParameters<typeof MeshMCPServer>[0];
}

describe("MCP Resources", () => {
  let server: MeshMCPServer;
  let mesh: ReturnType<typeof createMockMesh>;

  beforeEach(() => {
    mesh = createMockMesh();
    server = new MeshMCPServer(mesh as any);
  });

  describe("resources/list", () => {
    it("returns all 4 resources", () => {
      const result = (server as any)._handleListResources();
      expect(result.resources).toHaveLength(4);
      const uris = result.resources.map((r: any) => r.uri);
      expect(uris).toContain("mesh://goals");
      expect(uris).toContain("mesh://events/recent");
      expect(uris).toContain("mesh://state/checkpoints");
      expect(uris).toContain("mesh://status");
    });

    it("each resource has required fields", () => {
      const result = (server as any)._handleListResources();
      for (const r of result.resources) {
        expect(r).toHaveProperty("uri");
        expect(r).toHaveProperty("name");
        expect(r).toHaveProperty("description");
        expect(r).toHaveProperty("mimeType", "application/json");
      }
    });
  });

  describe("resources/read", () => {
    it("reads mesh://goals", () => {
      const result = (server as any)._handleReadResource("mesh://goals");
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe("mesh://goals");
      const data = JSON.parse(result.contents[0].text);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe("fix-ci");
    });

    it("reads mesh://events/recent", () => {
      const result = (server as any)._handleReadResource("mesh://events/recent");
      expect(result.contents).toHaveLength(1);
      const data = JSON.parse(result.contents[0].text);
      expect(data).toHaveLength(2);
      expect(data[0].type).toBe("ci.build.failed");
    });

    it("reads mesh://state/checkpoints", () => {
      const result = (server as any)._handleReadResource("mesh://state/checkpoints");
      expect(result.contents).toHaveLength(1);
      const data = JSON.parse(result.contents[0].text);
      expect(data).toHaveLength(1);
      expect(data[0].kind).toBe("observation");
    });

    it("reads mesh://status", () => {
      const result = (server as any)._handleReadResource("mesh://status");
      expect(result.contents).toHaveLength(1);
      const data = JSON.parse(result.contents[0].text);
      expect(data.running).toBe(true);
      expect(data.goals).toHaveLength(1);
      expect(data.operators).toContain("llm");
      expect(data.observers).toContain("github-webhook");
      expect(data.stateSeq).toBe(1);
    });

    it("throws on unknown resource URI", () => {
      expect(() => (server as any)._handleReadResource("mesh://unknown")).toThrow("Unknown resource: mesh://unknown");
    });
  });
});
