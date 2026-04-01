/**
 * ChannelRouter — routes messages between the mesh and messaging platforms.
 *
 * Core interface that all channel adapters implement. Keeps the contract
 * minimal so adding a new channel is straightforward.
 */

import type { EventBus, ObservationEvent } from "@openmesh/core";
import { randomUUID } from "node:crypto";

/** A message from/to a channel */
export interface ChannelMessage {
  /** Unique message ID */
  id: string;
  /** Channel this message is from/to */
  channel: string;
  /** Sender identifier (user ID, phone number, etc.) */
  sender: string;
  /** Message text content */
  text: string;
  /** Optional: thread/conversation ID */
  threadId?: string;
  /** Optional: reply to message ID */
  replyTo?: string;
  /** Optional: attachments/media */
  attachments?: Array<{ type: string; url: string; name?: string }>;
  /** Timestamp */
  timestamp: string;
  /** Raw platform-specific data */
  metadata?: Record<string, unknown>;
}

/** Configuration for a channel */
export interface ChannelConfig {
  /** Channel adapter ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Is this channel enabled? */
  enabled: boolean;
  /** Allowlist of sender IDs (empty = allow all) */
  allowFrom?: string[];
  /** Whether to require explicit mention/activation */
  requireMention?: boolean;
}

/** Channel adapter interface — implement this for each messaging platform */
export interface Channel {
  /** Unique channel ID (e.g., "slack", "discord", "telegram") */
  readonly id: string;
  readonly name: string;

  /** Start listening for inbound messages */
  start(onMessage: (msg: ChannelMessage) => void): Promise<void>;

  /** Send a message to this channel */
  send(message: ChannelMessage): Promise<void>;

  /** Stop the channel adapter */
  stop(): Promise<void>;
}

/**
 * ChannelRouter — central hub for all channel adapters.
 *
 * Inbound messages → EventBus as `channel.<id>.message` events.
 * Outbound: operators call router.send() to reach any channel.
 */
export class ChannelRouter {
  private channels = new Map<string, Channel>();
  private configs = new Map<string, ChannelConfig>();
  private bus?: EventBus;

  /** Register a channel adapter */
  addChannel(channel: Channel, config?: Partial<ChannelConfig>): this {
    this.channels.set(channel.id, channel);
    this.configs.set(channel.id, {
      id: channel.id,
      name: config?.name ?? channel.name,
      enabled: config?.enabled ?? true,
      allowFrom: config?.allowFrom,
      requireMention: config?.requireMention,
    });
    return this;
  }

  /** Wire to an EventBus — inbound messages become events */
  connectBus(bus: EventBus): this {
    this.bus = bus;
    return this;
  }

  /** Start all enabled channels */
  async startAll(): Promise<void> {
    for (const [id, channel] of this.channels) {
      const config = this.configs.get(id);
      if (!config?.enabled) continue;

      await channel.start(async (msg) => {
        // Allowlist check
        if (config.allowFrom?.length && !config.allowFrom.includes(msg.sender)) {
          return; // Silently drop unauthorized messages
        }

        // Emit as event into the mesh
        if (this.bus) {
          const event: ObservationEvent = {
            id: randomUUID(),
            type: `channel.${id}.message`,
            timestamp: msg.timestamp,
            source: `channel:${id}`,
            payload: {
              sender: msg.sender,
              text: msg.text,
              threadId: msg.threadId,
              replyTo: msg.replyTo,
              attachments: msg.attachments,
              channelId: id,
            },
          };
          await this.bus.emit(event);
        }
      });
    }
  }

  /** Send a message to a specific channel */
  async send(channelId: string, message: Omit<ChannelMessage, "id" | "timestamp">): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Unknown channel: ${channelId}`);

    await channel.send({
      ...message,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    });
  }

  /** Broadcast a message to all enabled channels */
  async broadcast(text: string, sender?: string): Promise<void> {
    for (const [id, config] of this.configs) {
      if (!config.enabled) continue;
      await this.send(id, { channel: id, sender: sender ?? "openmesh", text });
    }
  }

  /** Stop all channels */
  async stopAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      await channel.stop();
    }
  }

  /** List registered channels */
  list(): ChannelConfig[] {
    return [...this.configs.values()];
  }
}
