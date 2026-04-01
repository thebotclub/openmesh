/**
 * TelegramChannel — Telegram adapter using Bot API.
 *
 * Uses Telegram's HTTP Bot API directly. For production with high traffic,
 * consider using grammY or telegraf.js which add middleware, session
 * management, and webhook support.
 */

import type { Channel, ChannelMessage } from "../router.js";
import { randomUUID } from "node:crypto";

export interface TelegramChannelConfig {
  /** Telegram Bot Token from @BotFather */
  botToken: string;
  /** Default chat ID to send messages to */
  defaultChatId?: string;
  /** Polling interval (ms, default: 3000) */
  pollIntervalMs?: number;
}

export class TelegramChannel implements Channel {
  readonly id = "telegram";
  readonly name = "Telegram";
  private config: TelegramChannelConfig;
  private pollTimer?: ReturnType<typeof setInterval>;
  private lastUpdateId = 0;
  private baseUrl: string;

  constructor(config?: Partial<TelegramChannelConfig>) {
    this.config = {
      botToken: config?.botToken ?? process.env["TELEGRAM_BOT_TOKEN"] ?? "",
      defaultChatId: config?.defaultChatId ?? process.env["TELEGRAM_DEFAULT_CHAT_ID"],
      pollIntervalMs: config?.pollIntervalMs ?? 3000,
    };
    this.baseUrl = `https://api.telegram.org/bot${this.config.botToken}`;
  }

  async start(onMessage: (msg: ChannelMessage) => void): Promise<void> {
    if (!this.config.botToken) {
      throw new Error("TelegramChannel requires TELEGRAM_BOT_TOKEN");
    }

    this.pollTimer = setInterval(async () => {
      try {
        const resp = await fetch(
          `${this.baseUrl}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=1&allowed_updates=["message"]`,
        );
        const data = (await resp.json()) as {
          ok: boolean;
          result: Array<{
            update_id: number;
            message?: {
              message_id: number;
              chat: { id: number; title?: string };
              from: { id: number; username?: string; first_name: string };
              text?: string;
              date: number;
              reply_to_message?: { message_id: number };
            };
          }>;
        };

        if (!data.ok) return;

        for (const update of data.result) {
          this.lastUpdateId = update.update_id;
          if (!update.message?.text) continue;

          const msg = update.message;
          onMessage({
            id: randomUUID(),
            channel: "telegram",
            sender: msg.from.username ?? msg.from.first_name,
            text: msg.text ?? "",
            threadId: String(msg.chat.id),
            replyTo: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
            timestamp: new Date(msg.date * 1000).toISOString(),
            metadata: {
              telegramChatId: msg.chat.id,
              telegramUserId: msg.from.id,
              telegramMessageId: msg.message_id,
            },
          });
        }
      } catch (err) {
        console.error("[telegram] Poll error:", err);
      }
    }, this.config.pollIntervalMs);
  }

  async send(message: ChannelMessage): Promise<void> {
    const chatId: string | undefined = message.threadId ?? this.config.defaultChatId;
    if (!chatId) throw new Error("No Telegram chat ID specified");

    const resp = await fetch(`${this.baseUrl}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message.text,
        ...(message.replyTo ? { reply_to_message_id: Number(message.replyTo) } : {}),
      }),
    });

    const data = (await resp.json()) as { ok: boolean; description?: string };
    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description}`);
    }
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }
}
