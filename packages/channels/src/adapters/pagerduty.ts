/**
 * PagerDutyChannel — PagerDuty Events API v2 adapter.
 *
 * Sends alert triggers to PagerDuty via the Events API v2. PagerDuty is
 * alert-only (no inbound messages), so start() is a no-op unless a
 * webhook callback is configured in the future.
 */

import type { Channel, ChannelMessage } from "../router.js";

export interface PagerDutyChannelConfig {
  /** PagerDuty Events API v2 routing/integration key */
  routingKey: string;
  /** Default severity for triggered alerts */
  defaultSeverity?: "critical" | "error" | "warning" | "info";
  /** Source service URL shown in PagerDuty */
  serviceUrl?: string;
}

export class PagerDutyChannel implements Channel {
  readonly id = "pagerduty";
  readonly name = "PagerDuty";
  private config: PagerDutyChannelConfig;

  constructor(config?: Partial<PagerDutyChannelConfig>) {
    this.config = {
      routingKey: config?.routingKey ?? process.env["PAGERDUTY_ROUTING_KEY"] ?? "",
      defaultSeverity: config?.defaultSeverity
        ?? (process.env["PAGERDUTY_DEFAULT_SEVERITY"] as PagerDutyChannelConfig["defaultSeverity"])
        ?? "error",
      serviceUrl: config?.serviceUrl,
    };
  }

  async start(_onMessage: (msg: ChannelMessage) => void): Promise<void> {
    // PagerDuty is alert-only — no inbound message polling.
    // A future enhancement could accept webhook callbacks for
    // acknowledgements and resolutions.
  }

  async send(message: ChannelMessage): Promise<void> {
    if (!this.config.routingKey) {
      throw new Error("PagerDutyChannel requires PAGERDUTY_ROUTING_KEY");
    }

    const severity =
      (message.metadata?.["severity"] as PagerDutyChannelConfig["defaultSeverity"]) ??
      this.config.defaultSeverity ??
      "error";

    const dedupKey = message.metadata?.["dedupKey"] as string | undefined ?? message.threadId;

    const payload = {
      routing_key: this.config.routingKey,
      event_action: "trigger" as const,
      dedup_key: dedupKey,
      payload: {
        summary: message.text,
        source: message.sender ?? "openmesh",
        severity,
        timestamp: message.timestamp,
        ...(message.metadata?.["component"]
          ? { component: message.metadata["component"] as string }
          : {}),
        ...(message.metadata?.["group"]
          ? { group: message.metadata["group"] as string }
          : {}),
        ...(message.metadata?.["class"]
          ? { class: message.metadata["class"] as string }
          : {}),
      },
      ...(this.config.serviceUrl
        ? {
            links: [{ href: this.config.serviceUrl, text: "Service" }],
          }
        : {}),
    };

    const resp = await fetch("https://events.pagerduty.com/v2/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`PagerDuty API error (${resp.status}): ${body}`);
    }
  }

  async stop(): Promise<void> {
    // No-op — no persistent connections
  }
}
