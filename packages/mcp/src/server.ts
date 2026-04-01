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
} from "@modelcontextprotocol/sdk/types.js";
import type { Mesh, ObservationEvent, OperatorResult } from "@openmesh/core";

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

  constructor(mesh: Mesh, config?: MCPServerConfig) {
    this.mesh = mesh;

    this.server = new Server(
      {
        name: config?.name ?? "openmesh",
        version: config?.version ?? "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.setupHandlers(config);
  }

  private setupHandlers(config?: MCPServerConfig): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
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
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

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
    });
  }

  /** Start the MCP server on stdio transport */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  /** Get the server instance (for custom transports) */
  getServer(): Server {
    return this.server;
  }
}
