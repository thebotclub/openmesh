/**
 * WebhookChannel — universal inbound/outbound via HTTP webhooks.
 *
 * This is the simplest channel: receives POST requests on a configurable
 * endpoint and sends outbound messages via HTTP POST to a target URL.
 * Works with anything that speaks HTTP: n8n, Zapier, Make, custom apps.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Channel, ChannelMessage } from "../router.js";
import { randomUUID } from "node:crypto";

export class WebhookChannel implements Channel {
  readonly id = "webhook";
  readonly name = "Webhook";
  private server?: ReturnType<typeof createServer>;
  private port: number;
  private outboundUrl?: string;

  constructor(options?: { port?: number; outboundUrl?: string }) {
    this.port = options?.port ?? (Number(process.env["OPENMESH_WEBHOOK_PORT"]) || 3780);
    this.outboundUrl = options?.outboundUrl ?? process.env["OPENMESH_WEBHOOK_OUTBOUND_URL"];
  }

  async start(onMessage: (msg: ChannelMessage) => void): Promise<void> {
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end("Method Not Allowed");
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }

      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;

        onMessage({
          id: randomUUID(),
          channel: "webhook",
          sender: (body["sender"] as string) ?? "webhook",
          text: (body["text"] as string) ?? JSON.stringify(body),
          threadId: body["threadId"] as string | undefined,
          timestamp: new Date().toISOString(),
          metadata: body,
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400);
        res.end("Invalid JSON");
      }
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, () => resolve());
    });
  }

  async send(message: ChannelMessage): Promise<void> {
    if (!this.outboundUrl) return;

    const resp = await fetch(this.outboundUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: message.channel,
        sender: message.sender,
        text: message.text,
        threadId: message.threadId,
        timestamp: message.timestamp,
      }),
    });

    if (!resp.ok) {
      throw new Error(`Webhook send failed: ${resp.status} ${resp.statusText}`);
    }
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }
}
