/**
 * DiscordChannel — Discord adapter using Discord Bot HTTP API.
 *
 * Lightweight adapter using the Discord REST API + Gateway for receiving
 * messages. For production, users should use discord.js — this adapter
 * provides zero-dependency Discord support.
 */

import type { Channel, ChannelMessage } from "../router.js";
import { randomUUID } from "node:crypto";

export interface DiscordChannelConfig {
  /** Discord Bot Token */
  botToken: string;
  /** Default channel ID to post to */
  defaultChannelId?: string;
  /** Guild ID for the bot */
  guildId?: string;
}

export class DiscordChannel implements Channel {
  readonly id = "discord";
  readonly name = "Discord";
  private config: DiscordChannelConfig;
  private ws?: WebSocket;

  constructor(config?: Partial<DiscordChannelConfig>) {
    this.config = {
      botToken: config?.botToken ?? process.env["DISCORD_BOT_TOKEN"] ?? "",
      defaultChannelId: config?.defaultChannelId ?? process.env["DISCORD_DEFAULT_CHANNEL"],
      guildId: config?.guildId ?? process.env["DISCORD_GUILD_ID"],
    };
  }

  async start(onMessage: (msg: ChannelMessage) => void): Promise<void> {
    if (!this.config.botToken) {
      throw new Error("DiscordChannel requires DISCORD_BOT_TOKEN");
    }

    // Get Gateway URL
    const gatewayResp = await fetch("https://discord.com/api/v10/gateway/bot", {
      headers: { Authorization: `Bot ${this.config.botToken}` },
    });
    const gatewayData = (await gatewayResp.json()) as { url: string };

    // Connect to Gateway WebSocket
    this.ws = new WebSocket(`${gatewayData.url}?v=10&encoding=json`);

    let heartbeatInterval: ReturnType<typeof setInterval>;

    this.ws.onmessage = (event) => {
      const data = JSON.parse(String(event.data)) as {
        op: number;
        d: Record<string, unknown>;
        t?: string;
        s?: number;
      };

      // Hello — start heartbeat and identify
      if (data.op === 10) {
        const interval = (data.d as { heartbeat_interval: number }).heartbeat_interval;
        heartbeatInterval = setInterval(() => {
          this.ws?.send(JSON.stringify({ op: 1, d: null }));
        }, interval);

        // Identify
        this.ws?.send(
          JSON.stringify({
            op: 2,
            d: {
              token: this.config.botToken,
              intents: 1 << 9 | 1 << 15, // GUILD_MESSAGES | MESSAGE_CONTENT
              properties: { os: "linux", browser: "openmesh", device: "openmesh" },
            },
          }),
        );
      }

      // Message Create
      if (data.t === "MESSAGE_CREATE") {
        const msg = data.d as {
          id: string;
          channel_id: string;
          author: { id: string; username: string; bot?: boolean };
          content: string;
        };
        // Ignore bot messages
        if (msg.author.bot) return;

        onMessage({
          id: randomUUID(),
          channel: "discord",
          sender: msg.author.username,
          text: msg.content,
          threadId: msg.channel_id,
          timestamp: new Date().toISOString(),
          metadata: { discordUserId: msg.author.id, discordChannelId: msg.channel_id },
        });
      }
    };

    this.ws.onclose = () => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
    };
  }

  async send(message: ChannelMessage): Promise<void> {
    const channelId = message.threadId ?? this.config.defaultChannelId;
    if (!channelId) throw new Error("No Discord channel specified");

    const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${this.config.botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: message.text,
        ...(message.replyTo ? { message_reference: { message_id: message.replyTo } } : {}),
      }),
    });

    if (!resp.ok) {
      const err = (await resp.json()) as { message?: string };
      throw new Error(`Discord API error: ${err.message ?? resp.statusText}`);
    }
  }

  async stop(): Promise<void> {
    this.ws?.close();
  }
}
