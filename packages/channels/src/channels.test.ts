import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Channel, ChannelMessage } from "./router.js";
import { ChannelRouter } from "./router.js";
import { ChannelObserver, createChannelObserver } from "./observer.js";
import { ChannelOperator, createChannelOperator } from "./operator.js";

// ── Mock fetch globally ─────────────────────────────────────────────

const mockFetch = vi.fn<(...args: unknown[]) => Promise<Response>>();
vi.stubGlobal("fetch", mockFetch);

// ── Mock node:http for WebhookChannel ───────────────────────────────

const mockListen = vi.fn((_port: number, cb: () => void) => cb());
const mockClose = vi.fn((cb: () => void) => cb());
const mockServer = { listen: mockListen, close: mockClose };
const mockCreateServer = vi.fn(() => mockServer);

vi.mock("node:http", () => ({
  createServer: mockCreateServer,
}));

// ── Helpers ─────────────────────────────────────────────────────────

function makeFakeChannel(id: string, name?: string): Channel & {
  start: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  return {
    id,
    name: name ?? id,
    start: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: "msg-1",
    channel: "test",
    sender: "user-1",
    text: "hello",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── ChannelRouter ───────────────────────────────────────────────────

describe("ChannelRouter", () => {
  let router: ChannelRouter;

  beforeEach(() => {
    router = new ChannelRouter();
  });

  it("addChannel() registers a channel and returns this for chaining", () => {
    const ch = makeFakeChannel("slack");
    const result = router.addChannel(ch);
    expect(result).toBe(router);
  });

  it("list() returns registered channel configs", () => {
    router.addChannel(makeFakeChannel("slack"), { name: "My Slack" });
    router.addChannel(makeFakeChannel("discord"));

    const configs = router.list();
    expect(configs).toHaveLength(2);
    expect(configs[0]!.id).toBe("slack");
    expect(configs[0]!.name).toBe("My Slack");
    expect(configs[0]!.enabled).toBe(true);
    expect(configs[1]!.id).toBe("discord");
  });

  it("addChannel() uses defaults for missing config", () => {
    router.addChannel(makeFakeChannel("telegram", "Telegram Bot"));
    const configs = router.list();
    expect(configs[0]!.name).toBe("Telegram Bot");
    expect(configs[0]!.enabled).toBe(true);
    expect(configs[0]!.allowFrom).toBeUndefined();
    expect(configs[0]!.requireMention).toBeUndefined();
  });

  it("send() routes to the correct channel", async () => {
    const slack = makeFakeChannel("slack");
    const discord = makeFakeChannel("discord");
    router.addChannel(slack).addChannel(discord);

    await router.send("slack", { channel: "slack", sender: "bot", text: "hi" });

    expect(slack.send).toHaveBeenCalledOnce();
    expect(discord.send).not.toHaveBeenCalled();
    const sent = slack.send.mock.calls[0]![0] as ChannelMessage;
    expect(sent.text).toBe("hi");
    expect(sent.id).toBeDefined();
    expect(sent.timestamp).toBeDefined();
  });

  it("send() throws for unknown channel", async () => {
    await expect(
      router.send("nonexistent", { channel: "x", sender: "bot", text: "hi" }),
    ).rejects.toThrow("Unknown channel: nonexistent");
  });

  it("broadcast() sends to all enabled channels", async () => {
    const slack = makeFakeChannel("slack");
    const discord = makeFakeChannel("discord");
    const disabled = makeFakeChannel("telegram");
    router.addChannel(slack).addChannel(discord).addChannel(disabled, { enabled: false });

    await router.broadcast("alert!");

    expect(slack.send).toHaveBeenCalledOnce();
    expect(discord.send).toHaveBeenCalledOnce();
    expect(disabled.send).not.toHaveBeenCalled();
  });

  it("broadcast() uses provided sender", async () => {
    const ch = makeFakeChannel("slack");
    router.addChannel(ch);
    await router.broadcast("yo", "custom-sender");

    const sent = ch.send.mock.calls[0]![0] as ChannelMessage;
    expect(sent.sender).toBe("custom-sender");
  });

  it("startAll() calls start() on enabled channels only", async () => {
    const enabled = makeFakeChannel("slack");
    const disabled = makeFakeChannel("discord");
    router.addChannel(enabled).addChannel(disabled, { enabled: false });

    await router.startAll();

    expect(enabled.start).toHaveBeenCalledOnce();
    expect(disabled.start).not.toHaveBeenCalled();
  });

  it("stopAll() calls stop() on all channels", async () => {
    const slack = makeFakeChannel("slack");
    const discord = makeFakeChannel("discord");
    router.addChannel(slack).addChannel(discord);

    await router.stopAll();

    expect(slack.stop).toHaveBeenCalledOnce();
    expect(discord.stop).toHaveBeenCalledOnce();
  });

  it("connectBus() wires inbound messages to the EventBus", async () => {
    const ch = makeFakeChannel("slack");
    let onMsg: ((msg: ChannelMessage) => void) | undefined;
    ch.start.mockImplementation(async (cb: (msg: ChannelMessage) => void) => {
      onMsg = cb;
    });

    const emitted: unknown[] = [];
    const bus = {
      emit: vi.fn(async (event: unknown) => { emitted.push(event); }),
      on: vi.fn(() => () => {}),
      clear: vi.fn(),
    };

    router.addChannel(ch);
    router.connectBus(bus as never);
    await router.startAll();

    // Simulate inbound message
    onMsg!(makeMessage({ channel: "slack", sender: "alice", text: "ping" }));

    // Wait for async emit
    await vi.waitFor(() => expect(bus.emit).toHaveBeenCalledOnce());

    const event = bus.emit.mock.calls[0]![0] as { type: string; payload: Record<string, unknown> };
    expect(event.type).toBe("channel.slack.message");
    expect(event.payload.text).toBe("ping");
    expect(event.payload.sender).toBe("alice");
  });

  it("connectBus() respects allowFrom filter", async () => {
    const ch = makeFakeChannel("slack");
    let onMsg: ((msg: ChannelMessage) => void) | undefined;
    ch.start.mockImplementation(async (cb: (msg: ChannelMessage) => void) => {
      onMsg = cb;
    });

    const bus = { emit: vi.fn(), on: vi.fn(() => () => {}), clear: vi.fn() };

    router.addChannel(ch, { allowFrom: ["alice"] });
    router.connectBus(bus as never);
    await router.startAll();

    // Allowed sender
    onMsg!(makeMessage({ sender: "alice", text: "allowed" }));
    await vi.waitFor(() => expect(bus.emit).toHaveBeenCalledOnce());

    // Blocked sender — should NOT emit
    onMsg!(makeMessage({ sender: "bob", text: "blocked" }));
    // Give time then assert still only 1
    await new Promise((r) => setTimeout(r, 50));
    expect(bus.emit).toHaveBeenCalledTimes(1);
  });
});

// ── ChannelObserver ─────────────────────────────────────────────────

describe("ChannelObserver", () => {
  it("has correct id and name", () => {
    const router = new ChannelRouter();
    const obs = new ChannelObserver(router);
    expect(obs.id).toBe("channels");
    expect(obs.name).toBe("Multi-Channel Observer");
    expect(obs.events).toEqual(["channel.*.message"]);
  });

  it("watch() starts channels and connects bus, abort stops them", async () => {
    const ch = makeFakeChannel("slack");
    const router = new ChannelRouter();
    router.addChannel(ch);

    const obs = createChannelObserver(router);
    const ac = new AbortController();
    const emitFn = vi.fn();

    // Abort shortly after watch starts (startAll resolves immediately with mocks)
    setTimeout(() => ac.abort(), 50);

    await obs.watch({
      emit: emitFn,
      signal: ac.signal,
    } as never);

    expect(ch.start).toHaveBeenCalledOnce();
    expect(ch.stop).toHaveBeenCalledOnce();
  });

  it("dispose() stops all channels", async () => {
    const ch = makeFakeChannel("discord");
    const router = new ChannelRouter();
    router.addChannel(ch);

    const obs = new ChannelObserver(router);
    await obs.dispose();

    expect(ch.stop).toHaveBeenCalledOnce();
  });
});

// ── ChannelOperator ─────────────────────────────────────────────────

describe("ChannelOperator", () => {
  let router: ChannelRouter;
  let op: ChannelOperator;
  let slack: ReturnType<typeof makeFakeChannel>;
  let discord: ReturnType<typeof makeFakeChannel>;

  beforeEach(() => {
    router = new ChannelRouter();
    slack = makeFakeChannel("slack");
    discord = makeFakeChannel("discord");
    router.addChannel(slack).addChannel(discord);
    op = createChannelOperator(router);
  });

  it("has correct id and description", () => {
    expect(op.id).toBe("channels");
    expect(op.name).toBe("Multi-Channel Operator");
    expect(op.description).toContain("Slack");
  });

  it("parses 'Send to <channel>: <msg>' format", async () => {
    const result = await op.execute({ task: "Send to slack: deploy success" } as never);
    expect(result.status).toBe("success");
    expect(result.summary).toContain("slack");
    expect(slack.send).toHaveBeenCalledOnce();
    const sent = slack.send.mock.calls[0]![0] as ChannelMessage;
    expect(sent.text).toBe("deploy success");
  });

  it("parses 'Broadcast: <msg>' format", async () => {
    const result = await op.execute({ task: "Broadcast: all hands" } as never);
    expect(result.status).toBe("success");
    expect(result.summary).toContain("Broadcasted");
    expect(slack.send).toHaveBeenCalledOnce();
    expect(discord.send).toHaveBeenCalledOnce();
  });

  it("parses 'Reply to <channel> thread <id>: <msg>' format", async () => {
    const result = await op.execute({
      task: "Reply to slack thread T123: got it",
    } as never);
    expect(result.status).toBe("success");
    expect(result.summary).toContain("thread T123");
    const sent = slack.send.mock.calls[0]![0] as ChannelMessage;
    expect(sent.threadId).toBe("T123");
    expect(sent.text).toBe("got it");
  });

  it("falls back to broadcast on unknown format", async () => {
    const result = await op.execute({ task: "some random text" } as never);
    expect(result.status).toBe("success");
    expect(result.summary).toContain("Broadcasted");
    expect(slack.send).toHaveBeenCalled();
    expect(discord.send).toHaveBeenCalled();
  });

  it("returns failure on channel send error", async () => {
    slack.send.mockRejectedValueOnce(new Error("network down"));
    const result = await op.execute({ task: "Send to slack: oops" } as never);
    expect(result.status).toBe("failure");
    expect(result.summary).toContain("network down");
  });

  it("includes durationMs in results", async () => {
    const result = await op.execute({ task: "Broadcast: timing" } as never);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── WebhookChannel ──────────────────────────────────────────────────

describe("WebhookChannel", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockCreateServer.mockClear();
    mockListen.mockClear();
    mockClose.mockClear();
  });

  it("constructor uses default port and no outbound URL", async () => {
    const { WebhookChannel } = await import("./adapters/webhook.js");
    const ch = new WebhookChannel();
    expect(ch.id).toBe("webhook");
    expect(ch.name).toBe("Webhook");
  });

  it("constructor accepts custom port and outboundUrl", async () => {
    const { WebhookChannel } = await import("./adapters/webhook.js");
    const ch = new WebhookChannel({ port: 9999, outboundUrl: "https://example.com/hook" });
    expect(ch.id).toBe("webhook");
  });

  it("send() calls fetch with correct payload", async () => {
    const { WebhookChannel } = await import("./adapters/webhook.js");
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    const ch = new WebhookChannel({ outboundUrl: "https://example.com/hook" });
    await ch.send(makeMessage({ text: "webhook msg", channel: "webhook" }));

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://example.com/hook");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body.text).toBe("webhook msg");
  });

  it("send() does nothing without outboundUrl", async () => {
    const { WebhookChannel } = await import("./adapters/webhook.js");
    const ch = new WebhookChannel({ outboundUrl: undefined });
    await ch.send(makeMessage());
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("send() throws on non-ok response", async () => {
    const { WebhookChannel } = await import("./adapters/webhook.js");
    mockFetch.mockResolvedValueOnce(new Response("error", { status: 500, statusText: "Server Error" }));

    const ch = new WebhookChannel({ outboundUrl: "https://example.com/hook" });
    await expect(ch.send(makeMessage())).rejects.toThrow("Webhook send failed");
  });

  it("stop() closes the server", async () => {
    const { WebhookChannel } = await import("./adapters/webhook.js");
    const ch = new WebhookChannel();
    await ch.start(vi.fn());
    await ch.stop();
    expect(mockClose).toHaveBeenCalledOnce();
  });
});

// ── SlackChannel ────────────────────────────────────────────────────

describe("SlackChannel", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("constructor defaults", async () => {
    const { SlackChannel } = await import("./adapters/slack.js");
    const ch = new SlackChannel({ botToken: "xoxb-test" });
    expect(ch.id).toBe("slack");
    expect(ch.name).toBe("Slack");
  });

  it("start() throws without botToken", async () => {
    const { SlackChannel } = await import("./adapters/slack.js");
    const ch = new SlackChannel({ botToken: "" });
    await expect(ch.start(vi.fn())).rejects.toThrow("SLACK_BOT_TOKEN");
  });

  it("send() posts to Slack API", async () => {
    const { SlackChannel } = await import("./adapters/slack.js");
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    const ch = new SlackChannel({ botToken: "xoxb-test", defaultChannel: "C123" });
    await ch.send(makeMessage({ text: "slack msg", threadId: "C123" }));

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(opts.headers).toHaveProperty("Authorization", "Bearer xoxb-test");
    const body = JSON.parse(opts.body as string);
    expect(body.text).toBe("slack msg");
    expect(body.channel).toBe("C123");
  });

  it("send() throws on Slack API error", async () => {
    const { SlackChannel } = await import("./adapters/slack.js");
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: false, error: "channel_not_found" }));

    const ch = new SlackChannel({ botToken: "xoxb-test", defaultChannel: "C123" });
    await expect(ch.send(makeMessage({ threadId: "C123" }))).rejects.toThrow("channel_not_found");
  });

  it("send() throws when no channel specified", async () => {
    const { SlackChannel } = await import("./adapters/slack.js");
    const ch = new SlackChannel({ botToken: "xoxb-test" });
    await expect(ch.send(makeMessage({ threadId: undefined }))).rejects.toThrow("No Slack channel");
  });

  it("stop() clears poll timer", async () => {
    const { SlackChannel } = await import("./adapters/slack.js");
    const ch = new SlackChannel({ botToken: "xoxb-test", defaultChannel: "C1", pollIntervalMs: 100_000 });
    await ch.start(vi.fn());
    await ch.stop();
    // No error = timer cleared successfully
  });
});

// ── TelegramChannel ─────────────────────────────────────────────────

describe("TelegramChannel", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("constructor defaults", async () => {
    const { TelegramChannel } = await import("./adapters/telegram.js");
    const ch = new TelegramChannel({ botToken: "123:ABC" });
    expect(ch.id).toBe("telegram");
    expect(ch.name).toBe("Telegram");
  });

  it("start() throws without botToken", async () => {
    const { TelegramChannel } = await import("./adapters/telegram.js");
    const ch = new TelegramChannel({ botToken: "" });
    await expect(ch.start(vi.fn())).rejects.toThrow("TELEGRAM_BOT_TOKEN");
  });

  it("send() posts to Telegram API", async () => {
    const { TelegramChannel } = await import("./adapters/telegram.js");
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    const ch = new TelegramChannel({ botToken: "123:ABC", defaultChatId: "999" });
    await ch.send(makeMessage({ text: "tg msg", threadId: "999" }));

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    const body = JSON.parse(opts.body as string);
    expect(body.text).toBe("tg msg");
    expect(body.chat_id).toBe("999");
  });

  it("send() throws on Telegram API error", async () => {
    const { TelegramChannel } = await import("./adapters/telegram.js");
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: false, description: "chat not found" }));

    const ch = new TelegramChannel({ botToken: "123:ABC", defaultChatId: "999" });
    await expect(ch.send(makeMessage({ threadId: "999" }))).rejects.toThrow("chat not found");
  });

  it("send() throws when no chatId specified", async () => {
    const { TelegramChannel } = await import("./adapters/telegram.js");
    const ch = new TelegramChannel({ botToken: "123:ABC" });
    await expect(ch.send(makeMessage({ threadId: undefined }))).rejects.toThrow("No Telegram chat ID");
  });

  it("stop() clears poll timer", async () => {
    const { TelegramChannel } = await import("./adapters/telegram.js");
    const ch = new TelegramChannel({ botToken: "123:ABC", pollIntervalMs: 100_000 });
    await ch.start(vi.fn());
    await ch.stop();
  });
});

// ── DiscordChannel ──────────────────────────────────────────────────

describe("DiscordChannel", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("constructor defaults", async () => {
    const { DiscordChannel } = await import("./adapters/discord.js");
    const ch = new DiscordChannel({ botToken: "discord-tok" });
    expect(ch.id).toBe("discord");
    expect(ch.name).toBe("Discord");
  });

  it("start() throws without botToken", async () => {
    const { DiscordChannel } = await import("./adapters/discord.js");
    const ch = new DiscordChannel({ botToken: "" });
    await expect(ch.start(vi.fn())).rejects.toThrow("DISCORD_BOT_TOKEN");
  });

  it("send() posts to Discord REST API", async () => {
    const { DiscordChannel } = await import("./adapters/discord.js");
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));

    const ch = new DiscordChannel({ botToken: "discord-tok", defaultChannelId: "ch-1" });
    await ch.send(makeMessage({ text: "discord msg", threadId: "ch-1" }));

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/v10/channels/ch-1/messages");
    expect(opts.headers).toHaveProperty("Authorization", "Bot discord-tok");
    const body = JSON.parse(opts.body as string);
    expect(body.content).toBe("discord msg");
  });

  it("send() throws when no channel specified", async () => {
    const { DiscordChannel } = await import("./adapters/discord.js");
    const ch = new DiscordChannel({ botToken: "discord-tok" });
    await expect(ch.send(makeMessage({ threadId: undefined }))).rejects.toThrow("No Discord channel");
  });

  it("send() throws on non-ok response", async () => {
    const { DiscordChannel } = await import("./adapters/discord.js");
    mockFetch.mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401));

    const ch = new DiscordChannel({ botToken: "bad", defaultChannelId: "ch-1" });
    await expect(ch.send(makeMessage({ threadId: "ch-1" }))).rejects.toThrow("Discord API error");
  });
});
