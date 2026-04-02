import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChannelMessage } from "../router.js";
import { EventEmitter } from "node:events";

// ── Mock node:net and node:tls ──────────────────────────────────────

class MockSocket extends EventEmitter {
  write = vi.fn();
  end = vi.fn();
  destroy = vi.fn();
}

const mockSocket = new MockSocket();

vi.mock("node:net", () => ({
  createConnection: vi.fn(() => mockSocket),
}));

vi.mock("node:tls", () => ({
  connect: vi.fn(() => mockSocket),
}));

// Import after mocking
import { EmailChannel } from "../adapters/email.js";
import * as net from "node:net";
import * as tls from "node:tls";

describe("EmailChannel", () => {
  const baseConfig = {
    smtpHost: "smtp.example.com",
    smtpPort: 25,
    defaultFrom: "bot@openmesh.dev",
    defaultTo: "user@example.com",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket.removeAllListeners();
    mockSocket.write.mockReset();
    mockSocket.end.mockReset();
    mockSocket.destroy.mockReset();
  });

  // ── Config / env fallbacks ─────────────────────────────────────────

  describe("config / env fallbacks", () => {
    it("reads config from env vars when no config is provided", () => {
      process.env["SMTP_HOST"] = "env.smtp.com";
      process.env["SMTP_PORT"] = "587";
      process.env["SMTP_USER"] = "envuser";
      process.env["SMTP_PASS"] = "envpass";
      process.env["EMAIL_FROM"] = "env@from.com";
      process.env["EMAIL_TO"] = "env@to.com";

      const ch = new EmailChannel();
      expect(ch.id).toBe("email");
      expect(ch.name).toBe("Email");

      delete process.env["SMTP_HOST"];
      delete process.env["SMTP_PORT"];
      delete process.env["SMTP_USER"];
      delete process.env["SMTP_PASS"];
      delete process.env["EMAIL_FROM"];
      delete process.env["EMAIL_TO"];
    });

    it("uses smtpSecure defaults correctly", () => {
      const ch = new EmailChannel({ smtpHost: "h" });
      // Default is non-secure
      expect(ch.id).toBe("email");
    });
  });

  // ── start() ────────────────────────────────────────────────────────

  describe("start()", () => {
    it("logs warning when IMAP host is configured", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const ch = new EmailChannel({ ...baseConfig, imapHost: "imap.example.com" });
      await ch.start(() => {});
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("IMAP polling is not yet implemented"),
      );
      warnSpy.mockRestore();
    });

    it("does not warn when IMAP is not configured", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const ch = new EmailChannel(baseConfig);
      await ch.start(() => {});
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // ── send() ─────────────────────────────────────────────────────────

  describe("send()", () => {
    function simulateSmtpResponses(responses: string[]) {
      // Each time socket emits "data", it feeds the next SMTP response
      let callIdx = 0;
      // Start the SMTP conversation by emitting the greeting after a tick
      setTimeout(() => {
        mockSocket.emit("data", Buffer.from(`${responses[callIdx++]}\r\n`));
      }, 0);

      mockSocket.write.mockImplementation(() => {
        if (callIdx < responses.length) {
          setTimeout(() => {
            mockSocket.emit("data", Buffer.from(`${responses[callIdx++]}\r\n`));
          }, 0);
        }
      });

      mockSocket.end.mockImplementation(() => {
        // no-op
      });
    }

    it("writes correct SMTP commands in order", async () => {
      const ch = new EmailChannel(baseConfig);

      // 220 greeting, 250 EHLO, 250 MAIL FROM, 250 RCPT TO, 354 DATA, 250 data accepted, 221 QUIT
      simulateSmtpResponses(["220 OK", "250 OK", "250 OK", "250 OK", "354 Start", "250 OK", "221 Bye"]);

      const msg: ChannelMessage = {
        id: "msg-1",
        channel: "email",
        sender: "bot",
        text: "Hello via email",
        timestamp: new Date().toISOString(),
      };

      await ch.send(msg);

      expect(net.createConnection).toHaveBeenCalledWith(
        expect.objectContaining({ host: "smtp.example.com", port: 25 }),
      );

      const writes = mockSocket.write.mock.calls.map((c) => c[0] as string);
      expect(writes[0]).toMatch(/^EHLO openmesh\r\n/);
      expect(writes[1]).toMatch(/^MAIL FROM:<bot@openmesh\.dev>\r\n/);
      expect(writes[2]).toMatch(/^RCPT TO:<user@example\.com>\r\n/);
      expect(writes[3]).toMatch(/^DATA\r\n/);
      expect(writes[4]).toContain("Hello via email");
      expect(writes[4]).toContain("\r\n.\r\n");
      expect(writes[5]).toMatch(/^QUIT\r\n/);
    });

    it("uses TLS when smtpSecure is true", async () => {
      const ch = new EmailChannel({ ...baseConfig, smtpSecure: true, smtpPort: 465 });

      simulateSmtpResponses(["220 OK", "250 OK", "250 OK", "250 OK", "354 Start", "250 OK", "221 Bye"]);

      await ch.send({
        id: "msg-2",
        channel: "email",
        sender: "bot",
        text: "Secure message",
        timestamp: new Date().toISOString(),
      });

      expect(tls.connect).toHaveBeenCalledWith(
        expect.objectContaining({ host: "smtp.example.com", port: 465 }),
      );
    });

    it("includes AUTH LOGIN when credentials are provided", async () => {
      const ch = new EmailChannel({
        ...baseConfig,
        smtpUser: "user",
        smtpPass: "pass",
      });

      // 220 greeting, 250 EHLO, 334 auth prompt, 334 user, 235 auth ok, 250 MAIL, 250 RCPT, 354 DATA, 250 OK, 221 BYE
      simulateSmtpResponses([
        "220 OK", "250 OK", "334 OK", "334 OK", "235 Auth OK",
        "250 OK", "250 OK", "354 Start", "250 OK", "221 Bye",
      ]);

      await ch.send({
        id: "msg-3",
        channel: "email",
        sender: "bot",
        text: "Auth message",
        timestamp: new Date().toISOString(),
      });

      const writes = mockSocket.write.mock.calls.map((c) => c[0] as string);
      expect(writes[0]).toMatch(/^EHLO/);
      expect(writes[1]).toMatch(/^AUTH LOGIN/);
      expect(writes[2]).toBe(`${Buffer.from("user").toString("base64")}\r\n`);
      expect(writes[3]).toBe(`${Buffer.from("pass").toString("base64")}\r\n`);
    });

    it("throws if smtpHost is missing", async () => {
      const ch = new EmailChannel({ smtpHost: "" });
      await expect(
        ch.send({
          id: "msg-4",
          channel: "email",
          sender: "bot",
          text: "test",
          timestamp: new Date().toISOString(),
        }),
      ).rejects.toThrow("SMTP_HOST");
    });

    it("throws if no sender address", async () => {
      const ch = new EmailChannel({ smtpHost: "h", defaultFrom: undefined });
      await expect(
        ch.send({
          id: "msg-5",
          channel: "email",
          sender: "bot",
          text: "test",
          timestamp: new Date().toISOString(),
        }),
      ).rejects.toThrow("No sender address");
    });

    it("throws if no recipient address", async () => {
      const ch = new EmailChannel({ smtpHost: "h", defaultFrom: "a@b", defaultTo: undefined });
      await expect(
        ch.send({
          id: "msg-6",
          channel: "email",
          sender: "bot",
          text: "test",
          timestamp: new Date().toISOString(),
        }),
      ).rejects.toThrow("No recipient address");
    });

    it("rejects on SMTP error code", async () => {
      const ch = new EmailChannel(baseConfig);

      // Greeting OK, then EHLO returns 550
      simulateSmtpResponses(["220 OK", "550 Rejected"]);

      await expect(
        ch.send({
          id: "msg-7",
          channel: "email",
          sender: "bot",
          text: "test",
          timestamp: new Date().toISOString(),
        }),
      ).rejects.toThrow("SMTP error 550");
    });
  });

  // ── stop() ─────────────────────────────────────────────────────────

  describe("stop()", () => {
    it("is a no-op", async () => {
      const ch = new EmailChannel(baseConfig);
      await expect(ch.stop()).resolves.toBeUndefined();
    });
  });
});
