/**
 * MatrixChannel — Matrix adapter using Client-Server API v1.x over HTTP.
 *
 * Uses the Matrix Client-Server API directly via fetch for zero-dependency
 * channel support. For production with E2EE or advanced features, users
 * should use matrix-js-sdk.
 */

import type { Channel, ChannelMessage } from "../router.js";
import { randomUUID } from "node:crypto";

export interface MatrixChannelConfig {
  /** Matrix homeserver URL (e.g. https://matrix.org) */
  homeserverUrl: string;
  /** Access token for authentication */
  accessToken: string;
  /** Default room ID to send/receive messages */
  defaultRoomId?: string;
  /** Long-poll interval for sync (ms, default: 30000) */
  pollIntervalMs?: number;
  /** The authenticated user's Matrix ID */
  userId?: string;
}

export class MatrixChannel implements Channel {
  readonly id = "matrix";
  readonly name = "Matrix";
  private config: MatrixChannelConfig;
  private syncToken?: string;
  private running = false;
  private abortController?: AbortController;

  constructor(config?: Partial<MatrixChannelConfig>) {
    this.config = {
      homeserverUrl: config?.homeserverUrl ?? process.env["MATRIX_HOMESERVER_URL"] ?? "",
      accessToken: config?.accessToken ?? process.env["MATRIX_ACCESS_TOKEN"] ?? "",
      defaultRoomId: config?.defaultRoomId ?? process.env["MATRIX_DEFAULT_ROOM"],
      pollIntervalMs: config?.pollIntervalMs ?? 30000,
      userId: config?.userId ?? process.env["MATRIX_USER_ID"],
    };
  }

  async start(onMessage: (msg: ChannelMessage) => void): Promise<void> {
    if (!this.config.homeserverUrl) {
      throw new Error("MatrixChannel requires MATRIX_HOMESERVER_URL");
    }
    if (!this.config.accessToken) {
      throw new Error("MatrixChannel requires MATRIX_ACCESS_TOKEN");
    }

    this.running = true;
    this.pollSync(onMessage);
  }

  async send(message: ChannelMessage): Promise<void> {
    const roomId = message.threadId ?? this.config.defaultRoomId;
    if (!roomId) throw new Error("No Matrix room ID specified");

    const txnId = randomUUID();
    const url = `${this.config.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`;

    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        msgtype: "m.text",
        body: message.text,
      }),
    });

    if (!resp.ok) {
      const err = (await resp.json()) as { errcode?: string; error?: string };
      throw new Error(`Matrix API error: ${err.error ?? resp.statusText}`);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
  }

  private pollSync(onMessage: (msg: ChannelMessage) => void): void {
    if (!this.running) return;

    this.abortController = new AbortController();

    const params = new URLSearchParams({
      timeout: String(this.config.pollIntervalMs),
      ...(this.syncToken ? { since: this.syncToken } : {}),
    });

    const url = `${this.config.homeserverUrl}/_matrix/client/v3/sync?${params.toString()}`;

    fetch(url, {
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
      signal: this.abortController.signal,
    })
      .then(async (resp) => {
        if (!resp.ok) return;

        const data = (await resp.json()) as {
          next_batch: string;
          rooms?: {
            join?: Record<
              string,
              {
                timeline?: {
                  events?: Array<{
                    type: string;
                    sender: string;
                    content: { msgtype?: string; body?: string };
                    event_id: string;
                    origin_server_ts: number;
                  }>;
                };
              }
            >;
          };
        };

        this.syncToken = data.next_batch;

        const joinedRooms = data.rooms?.join ?? {};
        for (const [roomId, room] of Object.entries(joinedRooms)) {
          const events = room.timeline?.events ?? [];
          for (const event of events) {
            if (event.type !== "m.room.message") continue;
            // Skip own messages
            if (this.config.userId && event.sender === this.config.userId) continue;

            onMessage({
              id: randomUUID(),
              channel: "matrix",
              sender: event.sender,
              text: event.content.body ?? "",
              threadId: roomId,
              timestamp: new Date(event.origin_server_ts).toISOString(),
              metadata: {
                matrixEventId: event.event_id,
                matrixRoomId: roomId,
                msgtype: event.content.msgtype,
              },
            });
          }
        }
      })
      .catch((err) => {
        if ((err as Error).name === "AbortError") return;
        console.error("[matrix] Sync error:", err);
      })
      .finally(() => {
        if (this.running) {
          this.pollSync(onMessage);
        }
      });
  }
}
