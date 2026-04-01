/**
 * @openmesh/mcp — Model Context Protocol integration.
 *
 * Two-way MCP bridge:
 *   1. MCP Server: Exposes OpenMesh operators as MCP tools that any
 *      MCP client (Claude, Cursor, Windsurf, etc.) can use.
 *   2. MCP Client: Consumes external MCP servers, wrapping their tools
 *      as OpenMesh operators.
 *
 * Uses the official @modelcontextprotocol/sdk — the same SDK used by
 * Claude Code, OpenClaw, and the broader MCP ecosystem.
 *
 * WHY MCP:
 *   - Standard protocol adopted by Anthropic, OpenAI, Google, Microsoft
 *   - Opens OpenMesh to thousands of existing MCP tools
 *   - Lets AI coding agents (Claude, Cursor) interact with the mesh directly
 *   - Tools become composable across ecosystem boundaries
 */

export { MeshMCPServer, type MCPServerConfig } from "./server.js";
export { MeshMCPClient, type MCPClientConfig, mcpToolsToOperator } from "./client.js";
