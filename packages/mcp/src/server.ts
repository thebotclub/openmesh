/**
 * MeshMCPServer — exposes OpenMesh operators as MCP tools.
 *
 * Any MCP client (Claude Desktop, Cursor, Windsurf, VS Code Copilot)
 * can connect and use OpenMesh operators directly. This turns the mesh
 * into a tool provider for the entire AI agent ecosystem.
 *
 * Example: An AI coding agent connects via MCP and can:
 *   - mesh_inject: inject events into the mesh
 *   - mesh_status: check goal/operator status
 *   - mesh_execute: run an operator directly
 *   - mesh_goals: list/create/modify goals
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Mesh, ObservationEvent, OperatorResult } from "@openmesh/core";
import { MCPHttpTransport, type MCPHttpTransportConfig } from "./httpTransport.js";

export interface MCPServerConfig {
  /** Server name (shown to MCP clients) */
  name?: string;
  /** Server version */
  version?: string;
  /** Which operators to expose (default: all) */
  exposeOperators?: string[];
  /** Enable event injection tool */
  enableInject?: boolean;
  /** Enable goal management tools */
  enableGoals?: boolean;
}

export class MeshMCPServer {
  private server: Server;
  private mesh: Mesh;
  private httpTransport: MCPHttpTransport | null = null;
  private _config: MCPServerConfig | undefined;

  constructor(mesh: Mesh, config?: MCPServerConfig) {
    this.mesh = mesh;
    this._config = config;

    this.server = new Server(
      {
        name: config?.name ?? "openmesh",
        version: config?.version ?? "0.1.0",
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      },
    );

    this.setupHandlers(config);
  }

  private setupHandlers(config?: MCPServerConfig): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return this._handleListTools(config);
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return this._handleCallTool(request.params.name, request.params.arguments, config);
    });

    // Resource handlers
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return this._handleListResources();
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return this._handleReadResource(request.params.uri);
    });

    // Prompt handlers
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      return this._handleListPrompts();
    });

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      return this._handleGetPrompt(request.params.name, request.params.arguments);
    });
  }

  /** Shared handler: list available MCP tools */
  private _handleListTools(config?: MCPServerConfig): { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> } {
    const tools: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }> = [];

    // Expose each operator as a tool
    const operators = this.mesh.operators.list();
    const allowList = config?.exposeOperators;

    for (const op of operators) {
      if (allowList && !allowList.includes(op.id)) continue;

      tools.push({
        name: `mesh_op_${op.id}`,
        description: `[OpenMesh Operator] ${op.name}: ${op.description}`,
        inputSchema: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description: "Task description for the operator",
            },
          },
          required: ["task"],
        },
      });
    }

    // Event injection tool
    if (config?.enableInject !== false) {
      tools.push({
        name: "mesh_inject",
        description: "Inject an event into the OpenMesh event bus",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", description: "Event type (e.g., 'ci.build.failed')" },
            source: { type: "string", description: "Event source identifier" },
            payload: {
              type: "object",
              description: "Event payload",
              additionalProperties: true,
            },
          },
          required: ["type", "source"],
        },
      });
    }

    // Status tool
    tools.push({
      name: "mesh_status",
      description: "Get OpenMesh status — running goals, operators, recent events",
      inputSchema: {
        type: "object",
        properties: {},
      },
    });

    // Goal listing
    if (config?.enableGoals !== false) {
      tools.push({
        name: "mesh_goals",
        description: "List all registered goals and their current states",
        inputSchema: {
          type: "object",
          properties: {},
        },
      });
    }

    return { tools };
  }

  /** Shared handler: execute an MCP tool call */
  private async _handleCallTool(
    name: string,
    args: Record<string, unknown> | undefined,
    _config?: MCPServerConfig,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    // Operator tools
    if (name.startsWith("mesh_op_")) {
      const operatorId = name.slice("mesh_op_".length);
      const task = (args as Record<string, unknown>)?.["task"] as string;

      if (!task) {
        return { content: [{ type: "text", text: "Error: 'task' parameter is required" }] };
      }

      const controller = new AbortController();
      const result: OperatorResult = await this.mesh.operators.execute(operatorId, {
        task,
        event: {},
        signal: controller.signal,
        log: () => {},
        requestApproval: async (_desc: string) => true,
      });

      return {
        content: [{
          type: "text",
          text: `[${result.status}] ${result.summary}${result.data ? "\n\nData: " + JSON.stringify(result.data, null, 2) : ""}`,
        }],
      };
    }

    // Event injection
    if (name === "mesh_inject") {
      const params = args as Record<string, unknown>;
      const event: ObservationEvent = this.mesh.createEvent(
        params["type"] as string,
        params["source"] as string,
        (params["payload"] as Record<string, unknown>) ?? {},
      );
      await this.mesh.inject(event);
      return {
        content: [{ type: "text", text: `Event injected: ${event.type} (${event.id})` }],
      };
    }

    // Status
    if (name === "mesh_status") {
      const goals = this.mesh.goals.list();
      const operators = this.mesh.operators.list();
      const observers = this.mesh.observers.list();

      const status = {
        running: this.mesh.isRunning(),
        goals: goals.map((g) => ({ id: g.id, state: this.mesh.goals.getState(g.id) })),
        operators: operators.map((o) => o.id),
        observers: observers.map((o) => o.id),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    }

    // Goals listing
    if (name === "mesh_goals") {
      const goals = this.mesh.goals.list();
      const goalData = goals.map((g) => ({
        id: g.id,
        description: g.description,
        observing: g.observe.map((o) => o.type),
        steps: g.then.map((s) => `${s.label} → ${s.operator}`),
        state: this.mesh.goals.getState(g.id),
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(goalData, null, 2) }],
      };
    }

    return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }

  // ── Resource Handlers ───────────────────────────────────────────

  /** List available MCP resources */
  _handleListResources(): { resources: Array<{ uri: string; name: string; description: string; mimeType: string }> } {
    return {
      resources: [
        {
          uri: "mesh://goals",
          name: "Goals",
          description: "All loaded goal definitions",
          mimeType: "application/json",
        },
        {
          uri: "mesh://events/recent",
          name: "Recent Events",
          description: "Recent events from the EventBus WAL",
          mimeType: "application/json",
        },
        {
          uri: "mesh://state/checkpoints",
          name: "State Checkpoints",
          description: "State checkpoints from the StateStore",
          mimeType: "application/json",
        },
        {
          uri: "mesh://status",
          name: "Mesh Status",
          description: "Current mesh runtime status",
          mimeType: "application/json",
        },
      ],
    };
  }

  /** Read a resource by URI */
  _handleReadResource(uri: string): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
    if (uri === "mesh://goals") {
      const goals = this.mesh.goals.list();
      const data = goals.map((g) => ({
        id: g.id,
        description: g.description,
        observe: g.observe,
        steps: g.then.map((s) => ({ label: s.label, operator: s.operator, task: s.task })),
        state: this.mesh.goals.getState(g.id),
      }));
      return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
    }

    if (uri === "mesh://events/recent") {
      const events = this.mesh.bus.getLog();
      const recent = events.slice(-50);
      return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(recent, null, 2) }] };
    }

    if (uri === "mesh://state/checkpoints") {
      const checkpoints = this.mesh.state.query();
      const recent = checkpoints.slice(-50);
      return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(recent, null, 2) }] };
    }

    if (uri === "mesh://status") {
      const goals = this.mesh.goals.list();
      const operators = this.mesh.operators.list();
      const observers = this.mesh.observers.list();
      const status = {
        running: this.mesh.isRunning(),
        goals: goals.map((g) => ({ id: g.id, state: this.mesh.goals.getState(g.id) })),
        operators: operators.map((o) => o.id),
        observers: observers.map((o) => o.id),
        stateSeq: this.mesh.state.getSeq(),
      };
      return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(status, null, 2) }] };
    }

    throw new Error(`Unknown resource: ${uri}`);
  }

  // ── Prompt Handlers ─────────────────────────────────────────────

  /** List available MCP prompts */
  _handleListPrompts(): { prompts: Array<{ name: string; description: string; arguments?: Array<{ name: string; description: string; required?: boolean }> }> } {
    return {
      prompts: [
        {
          name: "create-goal",
          description: "Generate an OpenMesh goal YAML from a description",
          arguments: [
            { name: "description", description: "What the goal should do", required: true },
          ],
        },
        {
          name: "analyze-events",
          description: "Analyze recent mesh events",
          arguments: [
            { name: "window", description: "Number of recent events to analyze", required: false },
          ],
        },
        {
          name: "refine-goal",
          description: "Refine an existing goal based on feedback",
          arguments: [
            { name: "goalId", description: "ID of the goal to refine", required: true },
            { name: "feedback", description: "What to change or improve", required: true },
          ],
        },
      ],
    };
  }

  /** Get a prompt with arguments filled in */
  _handleGetPrompt(
    name: string,
    args?: Record<string, string>,
  ): { description: string; messages: Array<{ role: "user" | "assistant"; content: { type: "text"; text: string } }> } {
    if (name === "create-goal") {
      const description = args?.["description"] ?? "";
      return {
        description: "Create a new OpenMesh goal",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "Create an OpenMesh goal YAML for the following requirement:",
                "",
                `"${description}"`,
                "",
                "The goal YAML format is:",
                "```yaml",
                "id: <kebab-case-id>",
                "description: <what the goal does>",
                "observe:",
                "  - type: <event.type.pattern>",
                "then:",
                "  - label: <step-name>",
                "    operator: <operator-id>",
                "    task: <task-template with {{event.payload.*}} interpolation>",
                "```",
                "",
                "Requirements:",
                "- Use descriptive kebab-case IDs",
                "- Observe specific event patterns (use glob patterns like ci.build.*)",
                "- Each step should have a clear label and task description",
                "- Use {{event.payload.*}} to reference event data in tasks",
              ].join("\n"),
            },
          },
        ],
      };
    }

    if (name === "analyze-events") {
      const window = parseInt(args?.["window"] ?? "20", 10);
      const events = this.mesh.bus.getLog();
      const recent = events.slice(-window);
      return {
        description: "Analyze recent mesh events",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Analyze these ${recent.length} recent OpenMesh events and identify patterns, anomalies, or actionable insights:`,
                "",
                "```json",
                JSON.stringify(recent, null, 2),
                "```",
                "",
                "Consider:",
                "- Event frequency and timing patterns",
                "- Error or failure events that need attention",
                "- Correlations between event types",
                "- Suggestions for new goals based on observed patterns",
              ].join("\n"),
            },
          },
        ],
      };
    }

    if (name === "refine-goal") {
      const goalId = args?.["goalId"] ?? "";
      const feedback = args?.["feedback"] ?? "";
      const goal = this.mesh.goals.get(goalId);
      const goalJson = goal
        ? JSON.stringify(goal, null, 2)
        : `(Goal "${goalId}" not found)`;

      return {
        description: "Refine an existing goal",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "Refine the following OpenMesh goal based on the feedback below.",
                "",
                "Current goal definition:",
                "```json",
                goalJson,
                "```",
                "",
                `Feedback: "${feedback}"`,
                "",
                "Please provide the updated goal YAML with the requested changes.",
                "Explain what you changed and why.",
              ].join("\n"),
            },
          },
        ],
      };
    }

    throw new Error(`Unknown prompt: ${name}`);
  }

  /** Start the MCP server on stdio transport */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  /**
   * Start an HTTP/SSE transport for remote MCP clients.
   * Can run in addition to the stdio transport.
   */
  async startHttp(config?: MCPHttpTransportConfig): Promise<{ port: number; hostname: string }> {
    this.httpTransport = new MCPHttpTransport(config);

    this.httpTransport.onMessage(async (message) => {
      const msg = message as { method?: string; params?: Record<string, unknown>; id?: unknown };

      if (msg.method === "tools/list") {
        const result = this._handleListTools(this._config);
        return { jsonrpc: "2.0", result, id: msg.id ?? null };
      }

      if (msg.method === "tools/call") {
        const params = msg.params ?? {};
        const result = await this._handleCallTool(
          params["name"] as string,
          params["arguments"] as Record<string, unknown> | undefined,
          this._config,
        );
        return { jsonrpc: "2.0", result, id: msg.id ?? null };
      }

      if (msg.method === "resources/list") {
        const result = this._handleListResources();
        return { jsonrpc: "2.0", result, id: msg.id ?? null };
      }

      if (msg.method === "resources/read") {
        const params = msg.params ?? {};
        const result = this._handleReadResource(params["uri"] as string);
        return { jsonrpc: "2.0", result, id: msg.id ?? null };
      }

      if (msg.method === "prompts/list") {
        const result = this._handleListPrompts();
        return { jsonrpc: "2.0", result, id: msg.id ?? null };
      }

      if (msg.method === "prompts/get") {
        const params = msg.params ?? {};
        const result = this._handleGetPrompt(
          params["name"] as string,
          params["arguments"] as Record<string, string> | undefined,
        );
        return { jsonrpc: "2.0", result, id: msg.id ?? null };
      }

      return {
        jsonrpc: "2.0",
        error: { code: -32601, message: `Method not found: ${msg.method}` },
        id: msg.id ?? null,
      };
    });

    return this.httpTransport.start();
  }

  /** Stop the HTTP/SSE transport */
  async stopHttp(): Promise<void> {
    if (this.httpTransport) {
      await this.httpTransport.stop();
      this.httpTransport = null;
    }
  }

  /** Get the server instance (for custom transports) */
  getServer(): Server {
    return this.server;
  }
}
