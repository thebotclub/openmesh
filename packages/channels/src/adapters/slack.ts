/**
 * SlackChannel — Slack adapter using Slack Web API.
 *
 * Uses the Slack Web API directly (no @slack/bolt dependency needed
 * for the basic adapter). For full Slack Events API support, pair with
 * the existing @openmesh/observer-slack package.
 *
 * Production users should use @slack/bolt or @slack/web-api directly —
 * this adapter wraps the HTTP API for zero-dependency channel support.
 */

import type { Channel, ChannelMessage } from "../router.js";
import { randomUUID } from "node:crypto";

export interface SlackChannelConfig {
  /** Slack Bot Token (xoxb-...) */
  botToken: string;
  /** Default channel to post to */
  defaultChannel?: string;
  /** Polling interval for conversations (ms, default: 5000) */
  pollIntervalMs?: number;
}

export class SlackChannel implements Channel {
  readonly id = "slack";
  readonly name = "Slack";
  private config: SlackChannelConfig;
  private pollTimer?: ReturnType<typeof setInterval>;
  private lastTs?: string;

  constructor(config?: Partial<SlackChannelConfig>) {
    this.config = {
      botToken: config?.botToken ?? process.env["SLACK_BOT_TOKEN"] ?? "",
      defaultChannel: config?.defaultChannel ?? process.env["SLACK_DEFAULT_CHANNEL"],
      pollIntervalMs: config?.pollIntervalMs ?? 5000,
    };
  }

  async start(onMessage: (msg: ChannelMessage) => void): Promise<void> {
    if (!this.config.botToken) {
      throw new Error("SlackChannel requires SLACK_BOT_TOKEN");
    }

    // Poll for new messages (lightweight approach — no WebSocket)
    this.lastTs = String(Date.now() / 1000);

    if (this.config.defaultChannel) {
      this.pollTimer = setInterval(async () => {
        try {
          const messages = await this.fetchMessages(this.config.defaultChannel!);
          for (const msg of messages) {
            onMessage(msg);
          }
        } catch (err) {
          console.error("[slack] Poll error:", err);
        }
      }, this.config.pollIntervalMs);
    }
  }

  async send(message: ChannelMessage): Promise<void> {
    const channel = message.threadId ?? this.config.defaultChannel;
    if (!channel) throw new Error("No Slack channel specified");

    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel,
        text: message.text,
        ...(message.replyTo ? { thread_ts: message.replyTo } : {}),
      }),
    });

    const data = (await resp.json()) as { ok: boolean; error?: string };
    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`);
    }
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private async fetchMessages(channel: string): Promise<ChannelMessage[]> {
    const resp = await fetch(
      `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channel)}&oldest=${this.lastTs}&limit=10`,
      {
        headers: { Authorization: `Bearer ${this.config.botToken}` },
      },
    );

    const data = (await resp.json()) as {
      ok: boolean;
      messages?: Array<{ ts: string; user: string; text: string; thread_ts?: string }>;
    };

    if (!data.ok || !data.messages?.length) return [];

    this.lastTs = data.messages[0]!.ts;

    return data.messages.reverse().map((m) => ({
      id: randomUUID(),
      channel: "slack",
      sender: m.user,
      text: m.text,
      threadId: m.thread_ts ?? channel,
      timestamp: new Date(Number(m.ts) * 1000).toISOString(),
    }));
  }
}
