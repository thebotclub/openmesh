/**
 * MeshMCPClient — consumes external MCP servers as OpenMesh operators.
 *
 * This lets OpenMesh leverage the entire MCP tool ecosystem:
 *   - Filesystem tools, database tools, API tools
 *   - Browser automation (Playwright MCP)
 *   - Cloud provider tools (AWS, GCP, Azure MCPs)
 *   - Custom enterprise tools
 *
 * Each connected MCP server's tools become available as operators
 * that goals can reference in their `then` steps.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Operator, OperatorContext, OperatorResult } from "@openmesh/core";

export interface MCPClientConfig {
  /** Display name for this MCP connection */
  name: string;
  /** Command to start the MCP server */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Environment variables for the server process */
  env?: Record<string, string>;
  /** Operator ID prefix (default: "mcp_<name>") */
  operatorPrefix?: string;
}

export class MeshMCPClient {
  private client: Client;
  private config: MCPClientConfig;
  private connected = false;

  constructor(config: MCPClientConfig) {
    this.config = config;
    this.client = new Client(
      { name: `openmesh-${config.name}`, version: "0.1.0" },
      { capabilities: {} },
    );
  }

  /** Connect to the MCP server and discover tools */
  async connect(): Promise<void> {
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: this.config.env,
    });

    await this.client.connect(transport);
    this.connected = true;
  }

  /** Disconnect from the MCP server */
  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  /** List tools available from this MCP server */
  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    if (!this.connected) throw new Error("Not connected to MCP server");
    const result = await this.client.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  /** Call a tool on the MCP server */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean }> {
    if (!this.connected) throw new Error("Not connected to MCP server");
    const result = await this.client.callTool({ name: toolName, arguments: args });
    const contentArray = Array.isArray(result.content) ? result.content as Array<{ type: string; text?: string }> : [];
    const textContent = contentArray
      .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    return { content: textContent, isError: Boolean(result.isError) };
  }

  /**
   * Convert all tools from this MCP server into OpenMesh operators.
   * Each MCP tool becomes an operator with ID: `mcp_<serverName>_<toolName>`
   */
  async toOperators(): Promise<Operator[]> {
    const tools = await this.listTools();
    const prefix = this.config.operatorPrefix ?? `mcp_${this.config.name}`;

    return tools.map((tool) => ({
      id: `${prefix}_${tool.name}`,
      name: `[MCP:${this.config.name}] ${tool.name}`,
      description: tool.description ?? `MCP tool: ${tool.name}`,
      execute: async (ctx: OperatorContext): Promise<OperatorResult> => {
        const start = Date.now();
        try {
          // Parse task as JSON args, or use as single "input" arg
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(ctx.task);
          } catch {
            args = { input: ctx.task };
          }

          const result = await this.callTool(tool.name, args);

          return {
            status: result.isError ? "failure" : "success",
            summary: result.content.slice(0, 500),
            data: { fullOutput: result.content },
            durationMs: Date.now() - start,
          };
        } catch (err) {
          return {
            status: "failure",
            summary: `MCP tool ${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`,
            durationMs: Date.now() - start,
          };
        }
      },
    }));
  }
}

/**
 * Convenience: connect to an MCP server and return operators ready
 * for mesh.addOperator().
 *
 * @example
 * ```ts
 * const ops = await mcpToolsToOperator({
 *   name: "filesystem",
 *   command: "npx",
 *   args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
 * });
 * for (const op of ops) mesh.addOperator(op);
 * ```
 */
export async function mcpToolsToOperator(config: MCPClientConfig): Promise<Operator[]> {
  const client = new MeshMCPClient(config);
  await client.connect();
  return client.toOperators();
}
