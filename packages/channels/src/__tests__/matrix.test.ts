import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChannelMessage } from "../router.js";

// ── Mock fetch globally ─────────────────────────────────────────────

const mockFetch = vi.fn<(...args: unknown[]) => Promise<Response>>();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Import after stubbing
import { MatrixChannel } from "../adapters/matrix.js";

describe("MatrixChannel", () => {
  const baseConfig = {
    homeserverUrl: "https://matrix.example.com",
    accessToken: "syt_test_token",
    defaultRoomId: "!room:example.com",
    userId: "@bot:example.com",
    pollIntervalMs: 100,
  };

  beforeEach(() => {
    mockFetch.mockReset();
    // Default: return a never-resolving promise so recursive polling blocks
    // and doesn't spin. Individual tests mock specific calls with mockResolvedValueOnce.
    mockFetch.mockImplementation(
      () => new Promise<Response>(() => {}), // hangs forever — will be aborted by stop()
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  // ── Env var fallbacks ──────────────────────────────────────────────

  describe("config / env fallbacks", () => {
    it("reads config from env vars when no config is provided", () => {
      process.env["MATRIX_HOMESERVER_URL"] = "https://env.matrix.org";
      process.env["MATRIX_ACCESS_TOKEN"] = "env_token";
      process.env["MATRIX_DEFAULT_ROOM"] = "!envroom:matrix.org";
      process.env["MATRIX_USER_ID"] = "@envuser:matrix.org";

      const ch = new MatrixChannel();
      // Access private config via send (will use defaultRoomId)
      expect(ch.id).toBe("matrix");
      expect(ch.name).toBe("Matrix");

      delete process.env["MATRIX_HOMESERVER_URL"];
      delete process.env["MATRIX_ACCESS_TOKEN"];
      delete process.env["MATRIX_DEFAULT_ROOM"];
      delete process.env["MATRIX_USER_ID"];
    });
  });

  // ── start() ────────────────────────────────────────────────────────

  describe("start()", () => {
    it("throws if homeserverUrl is missing", async () => {
      const ch = new MatrixChannel({ homeserverUrl: "", accessToken: "tok" });
      await expect(ch.start(() => {})).rejects.toThrow("MATRIX_HOMESERVER_URL");
    });

    it("throws if accessToken is missing", async () => {
      const ch = new MatrixChannel({ homeserverUrl: "https://m.org", accessToken: "" });
      await expect(ch.start(() => {})).rejects.toThrow("MATRIX_ACCESS_TOKEN");
    });

    it("processes sync responses into ChannelMessages", async () => {
      const ch = new MatrixChannel(baseConfig);
      const messages: ChannelMessage[] = [];

      // First sync: returns messages
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          next_batch: "batch_2",
          rooms: {
            join: {
              "!room:example.com": {
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      sender: "@alice:example.com",
                      content: { msgtype: "m.text", body: "Hello Matrix!" },
                      event_id: "$event1",
                      origin_server_ts: 1700000000000,
                    },
                  ],
                },
              },
            },
          },
        }),
      );

      await ch.start((msg) => messages.push(msg));

      // Wait for first sync to complete
      await vi.waitFor(() => expect(messages.length).toBeGreaterThanOrEqual(1));

      await ch.stop();

      expect(messages[0]!.channel).toBe("matrix");
      expect(messages[0]!.sender).toBe("@alice:example.com");
      expect(messages[0]!.text).toBe("Hello Matrix!");
      expect(messages[0]!.threadId).toBe("!room:example.com");
      expect(messages[0]!.metadata).toMatchObject({
        matrixEventId: "$event1",
        matrixRoomId: "!room:example.com",
      });
    });

    it("skips own messages based on userId", async () => {
      const ch = new MatrixChannel(baseConfig);
      const messages: ChannelMessage[] = [];

      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          next_batch: "batch_2",
          rooms: {
            join: {
              "!room:example.com": {
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      sender: "@bot:example.com", // own userId
                      content: { msgtype: "m.text", body: "my own msg" },
                      event_id: "$event_own",
                      origin_server_ts: 1700000001000,
                    },
                    {
                      type: "m.room.message",
                      sender: "@other:example.com",
                      content: { msgtype: "m.text", body: "other msg" },
                      event_id: "$event_other",
                      origin_server_ts: 1700000002000,
                    },
                  ],
                },
              },
            },
          },
        }),
      );

      await ch.start((msg) => messages.push(msg));
      await vi.waitFor(() => expect(messages.length).toBeGreaterThanOrEqual(1));
      await ch.stop();

      expect(messages).toHaveLength(1);
      expect(messages[0]!.sender).toBe("@other:example.com");
    });

    it("ignores non-message events", async () => {
      const ch = new MatrixChannel(baseConfig);
      const messages: ChannelMessage[] = [];

      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          next_batch: "batch_2",
          rooms: {
            join: {
              "!room:example.com": {
                timeline: {
                  events: [
                    {
                      type: "m.room.member", // not m.room.message
                      sender: "@alice:example.com",
                      content: { membership: "join" },
                      event_id: "$event_join",
                      origin_server_ts: 1700000000000,
                    },
                  ],
                },
              },
            },
          },
        }),
      );

      await ch.start((msg) => messages.push(msg));
      // Wait for first sync to complete
      await vi.waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2));
      await ch.stop();

      expect(messages).toHaveLength(0);
    });
  });

  // ── send() ─────────────────────────────────────────────────────────

  describe("send()", () => {
    it("sends PUT request to correct Matrix endpoint", async () => {
      const ch = new MatrixChannel(baseConfig);
      mockFetch.mockResolvedValueOnce(jsonResponse({ event_id: "$sent1" }));

      const msg: ChannelMessage = {
        id: "msg-1",
        channel: "matrix",
        sender: "bot",
        text: "Hello world",
        threadId: "!room:example.com",
        timestamp: new Date().toISOString(),
      };

      await ch.send(msg);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0]! as [string, RequestInit];
      expect(url).toContain("/_matrix/client/v3/rooms/");
      expect(url).toContain("!room%3Aexample.com"); // encoded room ID
      expect(url).toContain("/send/m.room.message/");
      expect(opts.method).toBe("PUT");
      expect(opts.headers).toMatchObject({
        Authorization: "Bearer syt_test_token",
        "Content-Type": "application/json",
      });
      const body = JSON.parse(opts.body as string) as Record<string, unknown>;
      expect(body).toEqual({ msgtype: "m.text", body: "Hello world" });
    });

    it("uses defaultRoomId when no threadId", async () => {
      const ch = new MatrixChannel(baseConfig);
      mockFetch.mockResolvedValueOnce(jsonResponse({ event_id: "$sent2" }));

      await ch.send({
        id: "msg-2",
        channel: "matrix",
        sender: "bot",
        text: "test",
        timestamp: new Date().toISOString(),
      });

      const [url] = mockFetch.mock.calls[0]! as [string, RequestInit];
      expect(url).toContain(encodeURIComponent("!room:example.com"));
    });

    it("throws if no room ID available", async () => {
      const ch = new MatrixChannel({ ...baseConfig, defaultRoomId: undefined });
      await expect(
        ch.send({
          id: "msg-3",
          channel: "matrix",
          sender: "bot",
          text: "test",
          timestamp: new Date().toISOString(),
        }),
      ).rejects.toThrow("No Matrix room ID specified");
    });

    it("throws on API error response", async () => {
      const ch = new MatrixChannel(baseConfig);
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ errcode: "M_FORBIDDEN", error: "Not allowed" }, 403),
      );

      await expect(
        ch.send({
          id: "msg-4",
          channel: "matrix",
          sender: "bot",
          text: "test",
          threadId: "!room:example.com",
          timestamp: new Date().toISOString(),
        }),
      ).rejects.toThrow("Matrix API error: Not allowed");
    });
  });

  // ── stop() ─────────────────────────────────────────────────────────

  describe("stop()", () => {
    it("stops polling after stop() is called", async () => {
      const ch = new MatrixChannel(baseConfig);

      // First sync resolves, second will hang (default mock)
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ next_batch: "batch_1", rooms: { join: {} } }),
      );

      await ch.start(() => {});

      // Wait for first sync to complete and second to start
      await vi.waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2));

      await ch.stop();

      const callCount = mockFetch.mock.calls.length;
      // After stopping, no more fetch calls should be made
      await new Promise((r) => setTimeout(r, 50));
      expect(mockFetch.mock.calls.length).toBe(callCount);
    });
  });
});
