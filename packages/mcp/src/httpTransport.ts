/**
 * MCPHttpTransport — serves MCP over SSE + HTTP POST.
 *
 * Protocol:
 *   GET  /sse       → SSE stream for server→client messages
 *   POST /messages  → client→server JSON-RPC messages
 *   GET  /health    → health check
 *
 * Compatible with the MCP SSE transport specification.
 * This allows Claude Desktop, Cursor, VS Code, and other MCP clients
 * to connect remotely over HTTP instead of requiring stdio.
 *
 * Zero external dependencies — uses only node:http, node:url, node:crypto.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

export interface MCPHttpTransportConfig {
  /** Port to listen on (default: 4000) */
  port?: number;
  /** Hostname to bind to (default: "0.0.0.0") */
  hostname?: string;
  /** Enable CORS for browser-based clients */
  cors?: boolean;
  /** API key for authentication (optional) */
  apiKey?: string;
}

/**
 * MCPHttpTransport — serves MCP over SSE + HTTP POST.
 *
 * This transport is independent of the MCP SDK's built-in transports,
 * providing custom auth and CORS support out of the box.
 */
export class MCPHttpTransport {
  private httpServer: HttpServer | null = null;
  private sseClients: Set<ServerResponse> = new Set();
  private messageHandler: ((message: unknown) => Promise<unknown>) | null = null;

  constructor(private config: MCPHttpTransportConfig = {}) {}

  /** Set the handler that processes incoming JSON-RPC messages and returns responses */
  onMessage(handler: (message: unknown) => Promise<unknown>): void {
    this.messageHandler = handler;
  }

  /** Send a JSON-RPC notification/response to all connected SSE clients */
  send(message: unknown): void {
    const data = `data: ${JSON.stringify(message)}\n\n`;
    for (const client of this.sseClients) {
      client.write(data);
    }
  }

  /** Start the HTTP server */
  async start(): Promise<{ port: number; hostname: string }> {
    const port = this.config.port ?? 4000;
    const hostname = this.config.hostname ?? "0.0.0.0";

    this.httpServer = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    return new Promise((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(port, hostname, () => {
        this.httpServer!.removeListener("error", reject);
        const addr = this.httpServer!.address();
        const boundPort = typeof addr === "object" && addr ? addr.port : port;
        resolve({ port: boundPort, hostname });
      });
    });
  }

  /** Stop the HTTP server and close all SSE connections */
  async stop(): Promise<void> {
    // Close all SSE connections
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();

    // Close the HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      this.httpServer = null;
    }
  }

  /** Route incoming requests */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // CORS headers
    if (this.config.cors) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }

    // OPTIONS preflight
    if (req.method === "OPTIONS") {
      if (this.config.cors) {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(405);
        res.end();
      }
      return;
    }

    // Health check — no auth required
    if (pathname === "/health" && req.method === "GET") {
      this.handleHealth(res);
      return;
    }

    // Auth check for all other routes
    if (this.config.apiKey && !this.checkAuth(req)) {
      this.sendJson(res, 401, { error: "Unauthorized", message: "Invalid or missing API key" });
      return;
    }

    // Route
    if (pathname === "/sse" && req.method === "GET") {
      this.handleSSE(req, res);
    } else if (pathname === "/messages" && req.method === "POST") {
      this.handleMessages(req, res);
    } else {
      this.sendJson(res, 404, { error: "Not found" });
    }
  }

  /** GET /health — health check */
  private handleHealth(res: ServerResponse): void {
    this.sendJson(res, 200, {
      status: "ok",
      transport: "sse",
      connections: this.sseClients.size,
    });
  }

  /** GET /sse — establish SSE stream */
  private handleSSE(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...(this.config.cors ? { "Access-Control-Allow-Origin": "*" } : {}),
    });

    // Send initial endpoint info so the client knows where to POST
    res.write(`data: ${JSON.stringify({ endpoint: "/messages" })}\n\n`);

    this.sseClients.add(res);

    // Clean up on disconnect
    res.on("close", () => {
      this.sseClients.delete(res);
    });
  }

  /** POST /messages — accept JSON-RPC messages */
  private handleMessages(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        this.sendJson(res, 400, { error: "Invalid JSON", message: "Request body must be valid JSON" });
        return;
      }

      if (!this.messageHandler) {
        this.sendJson(res, 503, { error: "No handler", message: "Server not ready" });
        return;
      }

      this.messageHandler(parsed)
        .then((result) => {
          this.sendJson(res, 200, result);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.sendJson(res, 500, {
            jsonrpc: "2.0",
            error: { code: -32603, message: `Internal error: ${message}` },
            id: null,
          });
        });
    });
  }

  /** Validate API key using timing-safe comparison */
  private checkAuth(req: IncomingMessage): boolean {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return false;

    const provided = authHeader.slice("Bearer ".length);
    const expected = this.config.apiKey!;

    if (provided.length !== expected.length) return false;

    const a = Buffer.from(provided, "utf-8");
    const b = Buffer.from(expected, "utf-8");
    return timingSafeEqual(a, b);
  }

  /** Write a JSON response */
  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(json);
  }
}
