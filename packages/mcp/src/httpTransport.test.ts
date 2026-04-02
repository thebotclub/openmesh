import { describe, it, expect, afterEach } from "vitest";
import { request as httpRequest } from "node:http";
import { MCPHttpTransport, type MCPHttpTransportConfig } from "./httpTransport.js";

/** Helper: make an HTTP request and return { status, headers, body } */
function req(
  port: number,
  method: string,
  path: string,
  options?: { body?: string; headers?: Record<string, string> },
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      { hostname: "127.0.0.1", port, path, method, headers: options?.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );
    r.on("error", reject);
    if (options?.body) r.write(options.body);
    r.end();
  });
}

/** Helper: open an SSE connection and collect initial messages */
function openSSE(
  port: number,
  headers?: Record<string, string>,
): Promise<{ messages: string[]; close: () => void; waitForMessages: (n: number) => Promise<string[]> }> {
  return new Promise((resolve, reject) => {
    const messages: string[] = [];
    const r = httpRequest(
      { hostname: "127.0.0.1", port, path: "/sse", method: "GET", headers },
      (res) => {
        if (res.statusCode !== 200) {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => reject(new Error(`SSE status ${res.statusCode}: ${Buffer.concat(chunks).toString()}`)));
          return;
        }

        let buffer = "";
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const match = part.match(/^data: (.+)$/m);
            if (match?.[1]) messages.push(match[1]);
          }
        });

        // Allow the first message to arrive before resolving
        const check = setInterval(() => {
          if (messages.length > 0) {
            clearInterval(check);
            resolve({
              messages,
              close: () => r.destroy(),
              waitForMessages: (n: number) =>
                new Promise((res2) => {
                  const poll = setInterval(() => {
                    if (messages.length >= n) {
                      clearInterval(poll);
                      res2([...messages]);
                    }
                  }, 20);
                }),
            });
          }
        }, 20);
      },
    );
    r.on("error", reject);
    r.end();
  });
}

describe("MCPHttpTransport", () => {
  let transport: MCPHttpTransport;
  let port: number;

  /** Create and start a transport with the given config */
  async function startTransport(config?: MCPHttpTransportConfig): Promise<void> {
    transport = new MCPHttpTransport({ port: 0, ...config });
    const addr = await transport.start();
    port = addr.port;
  }

  afterEach(async () => {
    await transport?.stop();
  });

  // ── Health ────────────────────────────────────────────────

  it("GET /health returns 200 JSON with status", async () => {
    await startTransport();
    const res = await req(port, "GET", "/health");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(body.transport).toBe("sse");
    expect(typeof body.connections).toBe("number");
  });

  // ── SSE ───────────────────────────────────────────────────

  it("GET /sse establishes connection and sends initial endpoint message", async () => {
    await startTransport();
    const sse = await openSSE(port);
    try {
      expect(sse.messages.length).toBeGreaterThanOrEqual(1);
      const initial = JSON.parse(sse.messages[0]!);
      expect(initial.endpoint).toBe("/messages");
    } finally {
      sse.close();
    }
  });

  it("multiple SSE clients can connect", async () => {
    await startTransport();
    const sse1 = await openSSE(port);
    const sse2 = await openSSE(port);
    try {
      // Health should show 2 connections
      const res = await req(port, "GET", "/health");
      const body = JSON.parse(res.body);
      expect(body.connections).toBe(2);
    } finally {
      sse1.close();
      sse2.close();
    }
  });

  it("send() broadcasts to all SSE clients", async () => {
    await startTransport();
    const sse1 = await openSSE(port);
    const sse2 = await openSSE(port);
    try {
      transport.send({ jsonrpc: "2.0", method: "test/notification", params: {} });

      const msgs1 = await sse1.waitForMessages(2);
      const msgs2 = await sse2.waitForMessages(2);

      // Second message (index 1) should be the broadcast
      expect(JSON.parse(msgs1[1]!).method).toBe("test/notification");
      expect(JSON.parse(msgs2[1]!).method).toBe("test/notification");
    } finally {
      sse1.close();
      sse2.close();
    }
  });

  // ── POST /messages ────────────────────────────────────────

  it("POST /messages forwards to messageHandler and returns response", async () => {
    await startTransport();
    transport.onMessage(async (msg) => {
      const m = msg as { method: string; id: number };
      return { jsonrpc: "2.0", result: { echo: m.method }, id: m.id };
    });

    const res = await req(port, "POST", "/messages", {
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result.echo).toBe("tools/list");
    expect(body.id).toBe(1);
  });

  it("POST /messages returns 400 for invalid JSON", async () => {
    await startTransport();
    transport.onMessage(async () => ({}));

    const res = await req(port, "POST", "/messages", {
      body: "not json{{{",
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Invalid JSON");
  });

  it("POST /messages returns 503 when no handler is set", async () => {
    await startTransport();

    const res = await req(port, "POST", "/messages", {
      body: JSON.stringify({ jsonrpc: "2.0", method: "test", id: 1 }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(503);
  });

  // ── Auth ──────────────────────────────────────────────────

  it("rejects requests without valid API key when configured", async () => {
    await startTransport({ apiKey: "secret-key-123" });

    // No auth header
    const res1 = await req(port, "POST", "/messages", {
      body: JSON.stringify({ jsonrpc: "2.0", method: "test", id: 1 }),
    });
    expect(res1.status).toBe(401);

    // Wrong key
    const res2 = await req(port, "POST", "/messages", {
      body: JSON.stringify({ jsonrpc: "2.0", method: "test", id: 1 }),
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(res2.status).toBe(401);
  });

  it("allows requests with valid API key", async () => {
    await startTransport({ apiKey: "secret-key-123" });
    transport.onMessage(async () => ({ jsonrpc: "2.0", result: "ok", id: 1 }));

    const res = await req(port, "POST", "/messages", {
      body: JSON.stringify({ jsonrpc: "2.0", method: "test", id: 1 }),
      headers: { Authorization: "Bearer secret-key-123", "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
  });

  it("health endpoint bypasses auth", async () => {
    await startTransport({ apiKey: "secret-key-123" });
    const res = await req(port, "GET", "/health");
    expect(res.status).toBe(200);
  });

  it("allows all requests when no API key configured", async () => {
    await startTransport();
    transport.onMessage(async () => ({ jsonrpc: "2.0", result: "ok", id: 1 }));

    const res = await req(port, "POST", "/messages", {
      body: JSON.stringify({ jsonrpc: "2.0", method: "test", id: 1 }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
  });

  // ── CORS ──────────────────────────────────────────────────

  it("adds CORS headers when cors=true", async () => {
    await startTransport({ cors: true });
    const res = await req(port, "GET", "/health");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("OPTIONS preflight returns 204 with CORS headers", async () => {
    await startTransport({ cors: true });
    const res = await req(port, "OPTIONS", "/messages");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("OPTIONS returns 405 when cors is not enabled", async () => {
    await startTransport();
    const res = await req(port, "OPTIONS", "/messages");
    expect(res.status).toBe(405);
  });

  // ── Lifecycle ─────────────────────────────────────────────

  it("stop() closes server and SSE connections", async () => {
    await startTransport();
    const sse = await openSSE(port);

    // Verify connected
    const health = await req(port, "GET", "/health");
    expect(JSON.parse(health.body).connections).toBe(1);

    await transport.stop();

    // Server should be down — request should fail
    await expect(req(port, "GET", "/health")).rejects.toThrow();

    sse.close();
  });

  // ── 404 ───────────────────────────────────────────────────

  it("returns 404 for unknown routes", async () => {
    await startTransport();
    const res = await req(port, "GET", "/unknown");
    expect(res.status).toBe(404);
  });
});
