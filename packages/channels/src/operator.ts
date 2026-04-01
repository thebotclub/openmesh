/**
 * ChannelOperator — sends messages via the ChannelRouter.
 *
 * Goals can use this operator to send notifications, alerts, or
 * interactive messages to any connected channel.
 *
 * Task format:
 *   "Send to <channel>: <message>"
 *   "Broadcast: <message>"
 *   "Reply to <channel> thread <threadId>: <message>"
 */

import type { Operator, OperatorContext, OperatorResult } from "@openmesh/core";
import type { ChannelRouter } from "./router.js";

export class ChannelOperator implements Operator {
  readonly id = "channels";
  readonly name = "Multi-Channel Operator";
  readonly description = "Sends messages to any connected channel (Slack, Discord, Telegram, webhooks)";

  constructor(private router: ChannelRouter) {}

  async execute(ctx: OperatorContext): Promise<OperatorResult> {
    const start = Date.now();
    const task = ctx.task.trim();

    try {
      // Parse task format
      const broadcastMatch = /^broadcast:\s*(.+)$/i.exec(task);
      if (broadcastMatch) {
        await this.router.broadcast(broadcastMatch[1]!);
        return {
          status: "success",
          summary: `Broadcasted message to all channels`,
          durationMs: Date.now() - start,
        };
      }

      const sendMatch = /^send\s+to\s+(\w+):\s*(.+)$/i.exec(task);
      if (sendMatch) {
        const [, channelId, message] = sendMatch;
        await this.router.send(channelId!, {
          channel: channelId!,
          sender: "openmesh",
          text: message!,
        });
        return {
          status: "success",
          summary: `Sent message to ${channelId}`,
          durationMs: Date.now() - start,
        };
      }

      const replyMatch = /^reply\s+to\s+(\w+)\s+thread\s+(\S+):\s*(.+)$/i.exec(task);
      if (replyMatch) {
        const [, channelId, threadId, message] = replyMatch;
        await this.router.send(channelId!, {
          channel: channelId!,
          sender: "openmesh",
          text: message!,
          threadId: threadId!,
        });
        return {
          status: "success",
          summary: `Replied in ${channelId} thread ${threadId}`,
          durationMs: Date.now() - start,
        };
      }

      // Default: broadcast if no format matched
      await this.router.broadcast(task);
      return {
        status: "success",
        summary: `Broadcasted: ${task.slice(0, 100)}`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        status: "failure",
        summary: `Channel send failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
      };
    }
  }
}

/** Convenience factory */
export function createChannelOperator(router: ChannelRouter): ChannelOperator {
  return new ChannelOperator(router);
}
