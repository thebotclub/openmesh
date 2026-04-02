/**
 * EmailChannel — minimal SMTP send adapter using node:net / node:tls.
 *
 * Sends email via raw SMTP commands. IMAP inbound polling is not yet
 * implemented — for production, use a real SMTP/IMAP library like
 * nodemailer or imapflow.
 */

import type { Channel, ChannelMessage } from "../router.js";
import * as net from "node:net";
import * as tls from "node:tls";
import { randomUUID } from "node:crypto";

export interface EmailChannelConfig {
  /** SMTP server host */
  smtpHost: string;
  /** SMTP server port (default: 25 for plain, 465 for TLS) */
  smtpPort?: number;
  /** SMTP username for AUTH LOGIN */
  smtpUser?: string;
  /** SMTP password for AUTH LOGIN */
  smtpPass?: string;
  /** Use TLS (port 465, default: false) */
  smtpSecure?: boolean;
  /** IMAP server host (for future inbound support) */
  imapHost?: string;
  /** IMAP server port */
  imapPort?: number;
  /** IMAP username */
  imapUser?: string;
  /** IMAP password */
  imapPass?: string;
  /** Use TLS for IMAP */
  imapSecure?: boolean;
  /** Default sender address */
  defaultFrom?: string;
  /** Default recipient address */
  defaultTo?: string;
  /** Poll interval for IMAP (ms) */
  pollIntervalMs?: number;
}

export class EmailChannel implements Channel {
  readonly id = "email";
  readonly name = "Email";
  private config: EmailChannelConfig;

  constructor(config?: Partial<EmailChannelConfig>) {
    const smtpSecure = config?.smtpSecure ?? false;
    this.config = {
      smtpHost: config?.smtpHost ?? process.env["SMTP_HOST"] ?? "",
      smtpPort: config?.smtpPort ?? (process.env["SMTP_PORT"] ? Number(process.env["SMTP_PORT"]) : undefined),
      smtpUser: config?.smtpUser ?? process.env["SMTP_USER"],
      smtpPass: config?.smtpPass ?? process.env["SMTP_PASS"],
      smtpSecure,
      imapHost: config?.imapHost ?? process.env["IMAP_HOST"],
      imapPort: config?.imapPort ?? (process.env["IMAP_PORT"] ? Number(process.env["IMAP_PORT"]) : undefined),
      imapUser: config?.imapUser ?? process.env["IMAP_USER"],
      imapPass: config?.imapPass ?? process.env["IMAP_PASS"],
      imapSecure: config?.imapSecure,
      defaultFrom: config?.defaultFrom ?? process.env["EMAIL_FROM"],
      defaultTo: config?.defaultTo ?? process.env["EMAIL_TO"],
      pollIntervalMs: config?.pollIntervalMs ?? 60000,
    };
  }

  async start(_onMessage: (msg: ChannelMessage) => void): Promise<void> {
    // IMAP inbound is not yet implemented — log a warning.
    // For production, use a library like imapflow.
    if (this.config.imapHost) {
      console.warn("[email] IMAP polling is not yet implemented. Inbound messages will not be received.");
    }
  }

  async send(message: ChannelMessage): Promise<void> {
    if (!this.config.smtpHost) {
      throw new Error("EmailChannel requires SMTP_HOST");
    }

    const from = message.metadata?.["from"] as string | undefined ?? this.config.defaultFrom;
    const to = message.threadId ?? this.config.defaultTo;
    if (!from) throw new Error("No sender address specified (set defaultFrom or metadata.from)");
    if (!to) throw new Error("No recipient address specified (set defaultTo or threadId)");

    const port = this.config.smtpPort ?? (this.config.smtpSecure ? 465 : 25);
    const subject = message.metadata?.["subject"] as string | undefined ?? "OpenMesh Notification";
    const date = new Date().toUTCString();
    const messageId = `<${randomUUID()}@openmesh>`;

    const body = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Date: ${date}`,
      `Message-ID: ${messageId}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      message.text,
    ].join("\r\n");

    await this.smtpSend(port, from, to, body);
  }

  async stop(): Promise<void> {
    // No-op — no persistent connections
  }

  private smtpSend(port: number, from: string, to: string, body: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const opts = { host: this.config.smtpHost, port };
      const socket = this.config.smtpSecure
        ? tls.connect(opts as tls.ConnectionOptions)
        : net.createConnection(opts as net.NetConnectOpts);

      let buffer = "";
      let step = 0;

      const commands = [
        `EHLO openmesh\r\n`,
        // Auth commands are inserted conditionally below
        `MAIL FROM:<${from}>\r\n`,
        `RCPT TO:<${to}>\r\n`,
        `DATA\r\n`,
        `${body}\r\n.\r\n`,
        `QUIT\r\n`,
      ];

      // Insert AUTH LOGIN if credentials are provided
      if (this.config.smtpUser && this.config.smtpPass) {
        commands.splice(
          1,
          0,
          `AUTH LOGIN\r\n`,
          `${Buffer.from(this.config.smtpUser).toString("base64")}\r\n`,
          `${Buffer.from(this.config.smtpPass).toString("base64")}\r\n`,
        );
      }

      const sendNext = () => {
        if (step < commands.length) {
          socket.write(commands[step]!);
          step++;
        } else {
          socket.end();
          resolve();
        }
      };

      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        // SMTP responses end with \r\n; process complete lines
        while (buffer.includes("\r\n")) {
          const lineEnd = buffer.indexOf("\r\n");
          const line = buffer.slice(0, lineEnd);
          buffer = buffer.slice(lineEnd + 2);

          const code = parseInt(line.slice(0, 3), 10);
          // Multi-line responses have '-' at position 3; wait for final line
          if (line[3] === "-") continue;

          if (code >= 400) {
            socket.destroy();
            reject(new Error(`SMTP error ${code}: ${line}`));
            return;
          }

          sendNext();
        }
      });

      socket.on("error", (err: Error) => reject(err));
      socket.on("timeout", () => {
        socket.destroy();
        reject(new Error("SMTP connection timed out"));
      });
    });
  }
}
