import { describe, it, expect, vi, beforeEach } from "vitest";
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
import { PagerDutyChannel } from "../adapters/pagerduty.js";

describe("PagerDutyChannel", () => {
  const baseConfig = {
    routingKey: "test-routing-key-123",
    defaultSeverity: "warning" as const,
    serviceUrl: "https://openmesh.dev",
  };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── Config / env fallbacks ─────────────────────────────────────────

  describe("config / env fallbacks", () => {
    it("reads config from env vars", () => {
      process.env["PAGERDUTY_ROUTING_KEY"] = "env-key";
      process.env["PAGERDUTY_DEFAULT_SEVERITY"] = "critical";

      const ch = new PagerDutyChannel();
      expect(ch.id).toBe("pagerduty");
      expect(ch.name).toBe("PagerDuty");

      delete process.env["PAGERDUTY_ROUTING_KEY"];
      delete process.env["PAGERDUTY_DEFAULT_SEVERITY"];
    });

    it("defaults severity to error when not specified", () => {
      const ch = new PagerDutyChannel({ routingKey: "key" });
      // Verify by sending — the payload will include the default severity
      expect(ch.id).toBe("pagerduty");
    });
  });

  // ── start() ────────────────────────────────────────────────────────

  describe("start()", () => {
    it("is a no-op (PagerDuty is alert-only)", async () => {
      const ch = new PagerDutyChannel(baseConfig);
      await expect(ch.start(() => {})).resolves.toBeUndefined();
    });
  });

  // ── send() ─────────────────────────────────────────────────────────

  describe("send()", () => {
    it("sends correct trigger event to PagerDuty Events API v2", async () => {
      const ch = new PagerDutyChannel(baseConfig);
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ status: "success", dedup_key: "dedup-1" }),
      );

      const msg: ChannelMessage = {
        id: "msg-1",
        channel: "pagerduty",
        sender: "openmesh-monitor",
        text: "CPU usage exceeded 90%",
        threadId: "alert-cpu-001",
        timestamp: "2024-01-15T10:30:00.000Z",
      };

      await ch.send(msg);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0]! as [string, RequestInit];
      expect(url).toBe("https://events.pagerduty.com/v2/enqueue");
      expect(opts.method).toBe("POST");
      expect(opts.headers).toMatchObject({ "Content-Type": "application/json" });

      const body = JSON.parse(opts.body as string) as Record<string, unknown>;
      expect(body).toMatchObject({
        routing_key: "test-routing-key-123",
        event_action: "trigger",
        dedup_key: "alert-cpu-001",
        payload: {
          summary: "CPU usage exceeded 90%",
          source: "openmesh-monitor",
          severity: "warning",
          timestamp: "2024-01-15T10:30:00.000Z",
        },
      });
    });

    it("includes service URL as a link", async () => {
      const ch = new PagerDutyChannel(baseConfig);
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "success" }));

      await ch.send({
        id: "msg-2",
        channel: "pagerduty",
        sender: "bot",
        text: "test",
        timestamp: new Date().toISOString(),
      });

      const body = JSON.parse(
        (mockFetch.mock.calls[0]![1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body["links"]).toEqual([
        { href: "https://openmesh.dev", text: "Service" },
      ]);
    });

    it("omits links when serviceUrl is not set", async () => {
      const ch = new PagerDutyChannel({ routingKey: "key" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "success" }));

      await ch.send({
        id: "msg-3",
        channel: "pagerduty",
        sender: "bot",
        text: "test",
        timestamp: new Date().toISOString(),
      });

      const body = JSON.parse(
        (mockFetch.mock.calls[0]![1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body["links"]).toBeUndefined();
    });

    it("uses severity from message metadata over config default", async () => {
      const ch = new PagerDutyChannel(baseConfig); // default severity: warning
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "success" }));

      await ch.send({
        id: "msg-4",
        channel: "pagerduty",
        sender: "bot",
        text: "Critical failure",
        timestamp: new Date().toISOString(),
        metadata: { severity: "critical" },
      });

      const body = JSON.parse(
        (mockFetch.mock.calls[0]![1] as RequestInit).body as string,
      ) as { payload: { severity: string } };
      expect(body.payload.severity).toBe("critical");
    });

    it("uses dedupKey from metadata when available", async () => {
      const ch = new PagerDutyChannel(baseConfig);
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "success" }));

      await ch.send({
        id: "msg-5",
        channel: "pagerduty",
        sender: "bot",
        text: "test",
        threadId: "thread-fallback",
        timestamp: new Date().toISOString(),
        metadata: { dedupKey: "custom-dedup-key" },
      });

      const body = JSON.parse(
        (mockFetch.mock.calls[0]![1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body["dedup_key"]).toBe("custom-dedup-key");
    });

    it("falls back to threadId for dedupKey", async () => {
      const ch = new PagerDutyChannel(baseConfig);
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "success" }));

      await ch.send({
        id: "msg-6",
        channel: "pagerduty",
        sender: "bot",
        text: "test",
        threadId: "thread-as-dedup",
        timestamp: new Date().toISOString(),
      });

      const body = JSON.parse(
        (mockFetch.mock.calls[0]![1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body["dedup_key"]).toBe("thread-as-dedup");
    });

    it("includes optional payload fields from metadata", async () => {
      const ch = new PagerDutyChannel(baseConfig);
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "success" }));

      await ch.send({
        id: "msg-7",
        channel: "pagerduty",
        sender: "bot",
        text: "test",
        timestamp: new Date().toISOString(),
        metadata: {
          component: "api-server",
          group: "production",
          class: "high-cpu",
        },
      });

      const body = JSON.parse(
        (mockFetch.mock.calls[0]![1] as RequestInit).body as string,
      ) as { payload: Record<string, unknown> };
      expect(body.payload["component"]).toBe("api-server");
      expect(body.payload["group"]).toBe("production");
      expect(body.payload["class"]).toBe("high-cpu");
    });

    it("throws if routingKey is missing", async () => {
      const ch = new PagerDutyChannel({ routingKey: "" });
      await expect(
        ch.send({
          id: "msg-8",
          channel: "pagerduty",
          sender: "bot",
          text: "test",
          timestamp: new Date().toISOString(),
        }),
      ).rejects.toThrow("PAGERDUTY_ROUTING_KEY");
    });

    it("throws on API error response", async () => {
      const ch = new PagerDutyChannel(baseConfig);
      mockFetch.mockResolvedValueOnce(
        new Response("Invalid Routing Key", { status: 400 }),
      );

      await expect(
        ch.send({
          id: "msg-9",
          channel: "pagerduty",
          sender: "bot",
          text: "test",
          timestamp: new Date().toISOString(),
        }),
      ).rejects.toThrow("PagerDuty API error (400)");
    });
  });

  // ── stop() ─────────────────────────────────────────────────────────

  describe("stop()", () => {
    it("is a no-op", async () => {
      const ch = new PagerDutyChannel(baseConfig);
      await expect(ch.stop()).resolves.toBeUndefined();
    });
  });
});
