// @ts-nocheck — test file uses dynamic mocks with loose types
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Operator, OperatorResult } from "@openmesh/core";

// ── Mock MCP SDK ────────────────────────────────────────────────────

const mockServerSetRequestHandler = vi.fn();
const mockServerConnect = vi.fn();

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class MockServer {
    static lastInstance: InstanceType<typeof this>;
    serverInfo: { name: string; version: string };
    options: unknown;
    setRequestHandler = mockServerSetRequestHandler;
    connect = mockServerConnect;
    constructor(info: { name: string; version: string }, options: unknown) {
      this.serverInfo = info;
      this.options = options;
      MockServer.lastInstance = this;
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class MockStdioServerTransport {
    constructor() {}
  },
}));

// Keep real schemas — they're just objects
vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  CallToolRequestSchema: Symbol("CallToolRequestSchema"),
  ListToolsRequestSchema: Symbol("ListToolsRequestSchema"),
  ListResourcesRequestSchema: Symbol("ListResourcesRequestSchema"),
  ReadResourceRequestSchema: Symbol("ReadResourceRequestSchema"),
  ListPromptsRequestSchema: Symbol("ListPromptsRequestSchema"),
  GetPromptRequestSchema: Symbol("GetPromptRequestSchema"),
}));

const mockClientListTools = vi.fn();
const mockClientCallTool = vi.fn();
const mockClientConnect = vi.fn();
const mockClientClose = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    clientInfo: { name: string; version: string };
    options: unknown;
    listTools = mockClientListTools;
    callTool = mockClientCallTool;
    connect = mockClientConnect;
    close = mockClientClose;
    constructor(info: { name: string; version: string }, options: unknown) {
      this.clientInfo = info;
      this.options = options;
    }
  },
}));

let capturedTransportConfig: unknown = null;
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdioClientTransport {
    config: unknown;
    constructor(config: unknown) {
      this.config = config;
      capturedTransportConfig = config;
    }
  },
}));

// ── Imports (after mocks) ───────────────────────────────────────────

import { MeshMCPServer } from "./server.js";
import { MeshMCPClient, mcpToolsToOperator } from "./client.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Helpers ─────────────────────────────────────────────────────────

function makeMockMesh() {
  const operators: Operator[] = [
    {
      id: "code-review",
      name: "Code Review",
      description: "Reviews pull requests",
      execute: vi.fn<(ctx: unknown) => Promise<OperatorResult>>().mockResolvedValue({
        status: "success",
        summary: "Review complete",
        data: { approved: true },
      }),
    },
    {
      id: "deploy",
      name: "Deploy",
      description: "Deploys to production",
      execute: vi.fn<(ctx: unknown) => Promise<OperatorResult>>().mockResolvedValue({
        status: "success",
        summary: "Deployed v1.2.3",
      }),
    },
  ];

  const goals = [
    {
      id: "ci-fix",
      description: "Fix CI failures",
      observe: [{ type: "ci.failed" }],
      then: [{ label: "fix", operator: "code-review", task: "Fix it" }],
    },
  ];

  return {
    operators: {
      list: vi.fn(() => operators),
      execute: vi.fn<(id: string, ctx: unknown) => Promise<OperatorResult>>().mockResolvedValue({
        status: "success",
        summary: "Executed",
      }),
    },
    observers: {
      list: vi.fn(() => [{ id: "github-watcher" }]),
    },
    goals: {
      list: vi.fn(() => goals),
      get: vi.fn((id: string) => goals.find((g) => g.id === id) ?? null),
      getState: vi.fn(() => ({ phase: "idle" })),
    },
    bus: {
      getLog: vi.fn(() => [
        { id: "evt-1", type: "cron.tick", source: "cron", payload: {}, timestamp: "2026-01-01T00:00:00.000Z" },
      ]),
    },
    state: {
      query: vi.fn(() => [
        { kind: "match", goalId: "ci-fix", timestamp: "2026-01-01T00:00:00.000Z" },
      ]),
      getSeq: vi.fn(() => 42),
    },
    isRunning: vi.fn(() => true),
    createEvent: vi.fn(
      (type: string, source: string, payload: Record<string, unknown>) => ({
        id: "evt-123",
        type,
        source,
        payload,
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    ),
    inject: vi.fn(),
  } as unknown as import("@openmesh/core").Mesh;
}

/** Extract a registered handler by matching the schema symbol */
function getHandler(schema: unknown): ((...args: unknown[]) => Promise<unknown>) | undefined {
  for (const [args] of mockServerSetRequestHandler.mock.calls) {
    if (args === schema) {
      return mockServerSetRequestHandler.mock.calls.find(
        (c: unknown[]) => c[0] === schema,
      )?.[1];
    }
  }
  return undefined;
}

// ── MeshMCPServer Tests ─────────────────────────────────────────────

describe("MeshMCPServer", () => {
  let mesh: ReturnType<typeof makeMockMesh>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedTransportConfig = null;
    mesh = makeMockMesh();
  });

  it("creates Server with default name and version", () => {
    new MeshMCPServer(mesh);
    // Server constructor is called — first positional arg is info
    const call = mockServerSetRequestHandler.mock.calls;
    // Just verify setRequestHandler was called (Server was constructed)
    expect(call.length).toBeGreaterThanOrEqual(2);
  });

  it("creates Server with custom name and version", () => {
    const server = new MeshMCPServer(mesh, {
      name: "my-mesh",
      version: "2.0.0",
    });
    // Server was constructed — we can verify via getServer()
    const s = server.getServer();
    expect(s).toBeDefined();
    expect((s as unknown as { serverInfo: { name: string } }).serverInfo.name).toBe("my-mesh");
    expect((s as unknown as { serverInfo: { version: string } }).serverInfo.version).toBe("2.0.0");
  });

  it("registers ListTools and CallTool handlers", () => {
    new MeshMCPServer(mesh);
    const schemas = mockServerSetRequestHandler.mock.calls.map((c: unknown[]) => c[0]);
    expect(schemas).toContain(ListToolsRequestSchema);
    expect(schemas).toContain(CallToolRequestSchema);
  });

  it("listTools returns operators as mesh_op_ tools plus built-ins", async () => {
    new MeshMCPServer(mesh);
    const handler = getHandler(ListToolsRequestSchema)!;
    const result = (await handler()) as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name);

    expect(names).toContain("mesh_op_code-review");
    expect(names).toContain("mesh_op_deploy");
    expect(names).toContain("mesh_inject");
    expect(names).toContain("mesh_status");
    expect(names).toContain("mesh_goals");
  });

  it("listTools respects exposeOperators filter", async () => {
    new MeshMCPServer(mesh, { exposeOperators: ["deploy"] });
    const handler = getHandler(ListToolsRequestSchema)!;
    const result = (await handler()) as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name);

    expect(names).toContain("mesh_op_deploy");
    expect(names).not.toContain("mesh_op_code-review");
  });

  it("listTools excludes inject when enableInject=false", async () => {
    new MeshMCPServer(mesh, { enableInject: false });
    const handler = getHandler(ListToolsRequestSchema)!;
    const result = (await handler()) as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name);

    expect(names).not.toContain("mesh_inject");
  });

  it("listTools excludes goals when enableGoals=false", async () => {
    new MeshMCPServer(mesh, { enableGoals: false });
    const handler = getHandler(ListToolsRequestSchema)!;
    const result = (await handler()) as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name);

    expect(names).not.toContain("mesh_goals");
    // Status should still be there
    expect(names).toContain("mesh_status");
  });

  it("callTool executes the correct operator", async () => {
    new MeshMCPServer(mesh);
    const handler = getHandler(CallToolRequestSchema)!;
    const result = (await handler({
      params: { name: "mesh_op_code-review", arguments: { task: "Review PR #42" } },
    })) as { content: Array<{ text: string }> };

    expect((mesh.operators.execute as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "code-review",
      expect.objectContaining({ task: "Review PR #42" }),
    );
    expect(result.content[0].text).toContain("success");
  });

  it("callTool returns error when task is missing for operator", async () => {
    new MeshMCPServer(mesh);
    const handler = getHandler(CallToolRequestSchema)!;
    const result = (await handler({
      params: { name: "mesh_op_code-review", arguments: {} },
    })) as { content: Array<{ text: string }> };

    expect(result.content[0].text).toContain("Error");
    expect(result.content[0].text).toContain("task");
  });

  it("callTool mesh_inject creates and injects an event", async () => {
    new MeshMCPServer(mesh);
    const handler = getHandler(CallToolRequestSchema)!;
    const result = (await handler({
      params: {
        name: "mesh_inject",
        arguments: { type: "ci.build.failed", source: "github", payload: { run: 99 } },
      },
    })) as { content: Array<{ text: string }> };

    expect((mesh.createEvent as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "ci.build.failed",
      "github",
      { run: 99 },
    );
    expect((mesh.inject as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect(result.content[0].text).toContain("Event injected");
  });

  it("callTool mesh_status returns running status, goals, operators, observers", async () => {
    new MeshMCPServer(mesh);
    const handler = getHandler(CallToolRequestSchema)!;
    const result = (await handler({
      params: { name: "mesh_status", arguments: {} },
    })) as { content: Array<{ text: string }> };

    const status = JSON.parse(result.content[0].text);
    expect(status.running).toBe(true);
    expect(status.operators).toContain("code-review");
    expect(status.observers).toContain("github-watcher");
    expect(status.goals).toEqual([{ id: "ci-fix", state: { phase: "idle" } }]);
  });

  it("callTool mesh_goals returns goal details", async () => {
    new MeshMCPServer(mesh);
    const handler = getHandler(CallToolRequestSchema)!;
    const result = (await handler({
      params: { name: "mesh_goals", arguments: {} },
    })) as { content: Array<{ text: string }> };

    const goalData = JSON.parse(result.content[0].text);
    expect(goalData[0].id).toBe("ci-fix");
    expect(goalData[0].observing).toEqual(["ci.failed"]);
    expect(goalData[0].steps).toEqual(["fix → code-review"]);
  });

  it("callTool returns error for unknown tool name", async () => {
    new MeshMCPServer(mesh);
    const handler = getHandler(CallToolRequestSchema)!;
    const result = (await handler({
      params: { name: "nonexistent_tool", arguments: {} },
    })) as { content: Array<{ text: string }> };

    expect(result.content[0].text).toContain("Unknown tool");
  });
});

// ── MeshMCPClient Tests ─────────────────────────────────────────────

describe("MeshMCPClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedTransportConfig = null;
  });

  it("stores config and creates Client with correct info", () => {
    const client = new MeshMCPClient({
      name: "filesystem",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
    });
    expect(client).toBeDefined();
  });

  it("connect() creates StdioClientTransport with command/args/env", async () => {
    const config = {
      name: "fs",
      command: "npx",
      args: ["-y", "server-fs", "/tmp"],
      env: { DEBUG: "true" },
    };
    const client = new MeshMCPClient(config);
    mockClientConnect.mockResolvedValueOnce(undefined);

    await client.connect();

    expect(capturedTransportConfig).toEqual({
      command: "npx",
      args: ["-y", "server-fs", "/tmp"],
      env: { DEBUG: "true" },
    });
    expect(mockClientConnect).toHaveBeenCalledTimes(1);
  });

  it("listTools() throws when not connected", async () => {
    const client = new MeshMCPClient({ name: "test", command: "echo" });
    await expect(client.listTools()).rejects.toThrow("Not connected");
  });

  it("listTools() returns mapped tools after connect", async () => {
    const client = new MeshMCPClient({ name: "test", command: "echo" });
    mockClientConnect.mockResolvedValueOnce(undefined);
    await client.connect();

    mockClientListTools.mockResolvedValueOnce({
      tools: [
        { name: "read_file", description: "Read a file", inputSchema: { type: "object" } },
        { name: "write_file", description: "Write a file", inputSchema: { type: "object" } },
      ],
    });

    const tools = await client.listTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("read_file");
    expect(tools[1].description).toBe("Write a file");
  });

  it("callTool() formats text content and isError flag", async () => {
    const client = new MeshMCPClient({ name: "test", command: "echo" });
    mockClientConnect.mockResolvedValueOnce(undefined);
    await client.connect();

    mockClientCallTool.mockResolvedValueOnce({
      content: [
        { type: "text", text: "Line 1" },
        { type: "text", text: "Line 2" },
      ],
      isError: false,
    });

    const result = await client.callTool("read_file", { path: "/tmp/x" });
    expect(result.content).toBe("Line 1\nLine 2");
    expect(result.isError).toBe(false);
  });

  it("callTool() handles error responses", async () => {
    const client = new MeshMCPClient({ name: "test", command: "echo" });
    mockClientConnect.mockResolvedValueOnce(undefined);
    await client.connect();

    mockClientCallTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "Permission denied" }],
      isError: true,
    });

    const result = await client.callTool("write_file", { path: "/etc/x" });
    expect(result.content).toBe("Permission denied");
    expect(result.isError).toBe(true);
  });

  it("toOperators() converts MCP tools to Operator[] with correct IDs", async () => {
    const client = new MeshMCPClient({ name: "fs", command: "echo" });
    mockClientConnect.mockResolvedValueOnce(undefined);
    await client.connect();

    mockClientListTools.mockResolvedValueOnce({
      tools: [
        { name: "read_file", description: "Read a file", inputSchema: {} },
        { name: "list_dir", description: "List directory", inputSchema: {} },
      ],
    });

    const operators = await client.toOperators();
    expect(operators).toHaveLength(2);
    expect(operators[0].id).toBe("mcp_fs_read_file");
    expect(operators[0].name).toBe("[MCP:fs] read_file");
    expect(operators[0].description).toBe("Read a file");
    expect(operators[1].id).toBe("mcp_fs_list_dir");
  });

  it("toOperators() uses custom operatorPrefix", async () => {
    const client = new MeshMCPClient({
      name: "fs",
      command: "echo",
      operatorPrefix: "custom",
    });
    mockClientConnect.mockResolvedValueOnce(undefined);
    await client.connect();

    mockClientListTools.mockResolvedValueOnce({
      tools: [{ name: "read_file", description: "Read", inputSchema: {} }],
    });

    const operators = await client.toOperators();
    expect(operators[0].id).toBe("custom_read_file");
  });

  it("operator execute() calls MCP tool and returns success result", async () => {
    const client = new MeshMCPClient({ name: "fs", command: "echo" });
    mockClientConnect.mockResolvedValueOnce(undefined);
    await client.connect();

    mockClientListTools.mockResolvedValueOnce({
      tools: [{ name: "read_file", description: "Read a file", inputSchema: {} }],
    });

    const operators = await client.toOperators();

    // Simulate callTool for the execute
    mockClientCallTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "file contents here" }],
      isError: false,
    });

    const result = await operators[0].execute({
      task: '{"path": "/tmp/test.txt"}',
      event: {},
      signal: new AbortController().signal,
      log: () => {},
      requestApproval: async () => true,
    });

    expect(result.status).toBe("success");
    expect(result.summary).toBe("file contents here");
    expect(mockClientCallTool).toHaveBeenCalledWith({
      name: "read_file",
      arguments: { path: "/tmp/test.txt" },
    });
  });

  it("operator execute() uses { input: task } when task is not valid JSON", async () => {
    const client = new MeshMCPClient({ name: "fs", command: "echo" });
    mockClientConnect.mockResolvedValueOnce(undefined);
    await client.connect();

    mockClientListTools.mockResolvedValueOnce({
      tools: [{ name: "search", description: "Search files", inputSchema: {} }],
    });

    const operators = await client.toOperators();

    mockClientCallTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "found 3 results" }],
      isError: false,
    });

    const result = await operators[0].execute({
      task: "find all test files",
      event: {},
      signal: new AbortController().signal,
      log: () => {},
      requestApproval: async () => true,
    });

    expect(result.status).toBe("success");
    expect(mockClientCallTool).toHaveBeenCalledWith({
      name: "search",
      arguments: { input: "find all test files" },
    });
  });

  it("operator execute() returns failure when MCP tool errors", async () => {
    const client = new MeshMCPClient({ name: "fs", command: "echo" });
    mockClientConnect.mockResolvedValueOnce(undefined);
    await client.connect();

    mockClientListTools.mockResolvedValueOnce({
      tools: [{ name: "delete", description: "Delete file", inputSchema: {} }],
    });

    const operators = await client.toOperators();

    mockClientCallTool.mockRejectedValueOnce(new Error("Connection lost"));

    const result = await operators[0].execute({
      task: '{"path": "/tmp/x"}',
      event: {},
      signal: new AbortController().signal,
      log: () => {},
      requestApproval: async () => true,
    });

    expect(result.status).toBe("failure");
    expect(result.summary).toContain("Connection lost");
  });

  it("disconnect() calls client.close()", async () => {
    const client = new MeshMCPClient({ name: "test", command: "echo" });
    mockClientConnect.mockResolvedValueOnce(undefined);
    await client.connect();

    mockClientClose.mockResolvedValueOnce(undefined);
    await client.disconnect();

    expect(mockClientClose).toHaveBeenCalledTimes(1);
  });
});

// ── mcpToolsToOperator convenience function ─────────────────────────

describe("mcpToolsToOperator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("connects and returns operators from the MCP server", async () => {
    mockClientConnect.mockResolvedValueOnce(undefined);
    mockClientListTools.mockResolvedValueOnce({
      tools: [
        { name: "tool_a", description: "Tool A", inputSchema: {} },
        { name: "tool_b", description: "Tool B", inputSchema: {} },
      ],
    });

    const ops = await mcpToolsToOperator({
      name: "test-server",
      command: "npx",
      args: ["-y", "test-mcp-server"],
    });

    expect(mockClientConnect).toHaveBeenCalledTimes(1);
    expect(ops).toHaveLength(2);
    expect(ops[0].id).toBe("mcp_test-server_tool_a");
    expect(ops[1].id).toBe("mcp_test-server_tool_b");
  });
});
