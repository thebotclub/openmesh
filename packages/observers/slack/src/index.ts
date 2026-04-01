import { defineObserver } from "@openmesh/sdk";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

/**
 * Slack observer that receives events via Slack Events API (HTTP mode).
 *
 * Configure via environment variables:
 *   SLACK_SIGNING_SECRET  — used to verify request signatures
 *   SLACK_EVENTS_PORT     — HTTP port to listen on (default: 3400)
 *
 * Supports: message events, app_mention, reaction_added, url_verification challenge.
 */
export default defineObserver({
  id: "slack",
  name: "Slack Observer",
  events: [
    "slack.message",
    "slack.mention",
    "slack.reaction",
    "slack.thread.reply",
  ],
  async watch(ctx) {
    const port = parseInt(process.env.SLACK_EVENTS_PORT ?? "3400", 10);
    const signingSecret = process.env.SLACK_SIGNING_SECRET ?? "";

    if (!signingSecret) {
      ctx.log("Warning: SLACK_SIGNING_SECRET not set — signature verification disabled");
    }

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const rawBody = Buffer.concat(chunks).toString("utf-8");

      // Verify Slack signature if signing secret is configured
      if (signingSecret) {
        const timestamp = req.headers["x-slack-request-timestamp"] as string;
        const slackSig = req.headers["x-slack-signature"] as string;
        if (!timestamp || !slackSig) {
          res.writeHead(401);
          res.end("Missing signature headers");
          return;
        }
        // Reject requests older than 5 minutes to prevent replay attacks
        const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
        if (age > 300) {
          res.writeHead(401);
          res.end("Request too old");
          return;
        }
        const { createHmac } = await import("node:crypto");
        const sigBasestring = `v0:${timestamp}:${rawBody}`;
        const mySignature = "v0=" + createHmac("sha256", signingSecret).update(sigBasestring).digest("hex");
        if (mySignature !== slackSig) {
          res.writeHead(401);
          res.end("Invalid signature");
          return;
        }
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        res.writeHead(400);
        res.end("Invalid JSON");
        return;
      }

      // Handle Slack URL verification challenge
      if (payload.type === "url_verification") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(String(payload.challenge));
        return;
      }

      // Acknowledge Slack within 3s
      res.writeHead(200);
      res.end("ok");

      // Process event callbacks
      if (payload.type === "event_callback") {
        const event = payload.event as Record<string, unknown> | undefined;
        if (!event) return;

        const eventType = event.type as string;
        const meta = {
          channel: event.channel as string,
          user: event.user as string,
          text: event.text as string | undefined,
          ts: event.ts as string,
          threadTs: event.thread_ts as string | undefined,
        };

        switch (eventType) {
          case "message":
            // Skip bot messages to avoid loops
            if (event.bot_id || event.subtype === "bot_message") return;
            if (meta.threadTs) {
              ctx.emit({
                id: randomUUID(),
                type: "slack.thread.reply",
                timestamp: new Date().toISOString(),
                source: "slack",
                payload: {
                  channel: meta.channel,
                  user: meta.user,
                  text: meta.text ?? "",
                  threadTs: meta.threadTs,
                },
              });
            } else {
              ctx.emit({
                id: randomUUID(),
                type: "slack.message",
                timestamp: new Date().toISOString(),
                source: "slack",
                payload: {
                  channel: meta.channel,
                  user: meta.user,
                  text: meta.text ?? "",
                },
              });
            }
            break;

          case "app_mention":
            ctx.emit({
              id: randomUUID(),
              type: "slack.mention",
              timestamp: new Date().toISOString(),
              source: "slack",
              payload: {
                channel: meta.channel,
                user: meta.user,
                text: meta.text ?? "",
              },
            });
            break;

          case "reaction_added":
            ctx.emit({
              id: randomUUID(),
              type: "slack.reaction",
              timestamp: new Date().toISOString(),
              source: "slack",
              payload: {
                channel: meta.channel,
                user: event.user as string,
                reaction: event.reaction as string,
                itemUser: (event.item_user as string) ?? "",
              },
            });
            break;

          default:
            ctx.log(`Unhandled Slack event type: ${eventType}`);
        }
      }
    });

    ctx.log(`Slack Events API observer listening on :${port}`);
    server.listen(port);

    // Wait for abort
    await new Promise<void>((resolve) => {
      ctx.signal.addEventListener("abort", () => {
        server.close(() => resolve());
      }, { once: true });
    });
  },
});
