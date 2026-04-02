/**
 * MeshMetrics — OpenTelemetry metrics for the mesh runtime.
 *
 * Tracks operational metrics that matter:
 *   - Event throughput (events/sec by type)
 *   - Goal success/failure rates
 *   - Operator latency (p50, p95, p99)
 *   - Active goals count
 *
 * Exportable to Prometheus, Grafana, Datadog, or any OTLP backend.
 */

import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { Counter, Histogram, UpDownCounter } from "@opentelemetry/api";
import { MetricsRegistry } from "./prometheusExporter.js";

export class MeshMetrics {
  private provider: MeterProvider;
  private readonly registry = new MetricsRegistry();

  /** Total events processed */
  readonly eventsTotal: Counter;
  /** Goal executions by status */
  readonly goalExecutions: Counter;
  /** Operator execution duration */
  readonly operatorDuration: Histogram;
  /** Currently active goals */
  readonly activeGoals: UpDownCounter;
  /** Anomalies detected */
  readonly anomaliesDetected: Counter;
  /** Channel messages sent/received */
  readonly channelMessages: Counter;

  constructor(options?: { serviceName?: string }) {
    const serviceName = options?.serviceName ?? "openmesh";

    this.provider = new MeterProvider({
      resource: resourceFromAttributes({
        "service.name": serviceName,
        "service.version": "0.1.0",
      }),
    });

    const meter = this.provider.getMeter(serviceName);

    this.eventsTotal = meter.createCounter("mesh.events.total", {
      description: "Total events processed by the mesh",
    });

    this.goalExecutions = meter.createCounter("mesh.goals.executions", {
      description: "Goal executions by status",
    });

    this.operatorDuration = meter.createHistogram("mesh.operator.duration_ms", {
      description: "Operator execution duration in milliseconds",
    });

    this.activeGoals = meter.createUpDownCounter("mesh.goals.active", {
      description: "Currently executing goals",
    });

    this.anomaliesDetected = meter.createCounter("mesh.anomalies.detected", {
      description: "Anomalies detected by the AI detector",
    });

    this.channelMessages = meter.createCounter("mesh.channels.messages", {
      description: "Channel messages sent and received",
    });
  }

  recordEvent(eventType: string): void {
    this.eventsTotal.add(1, { "event.type": eventType });
    this.registry.incCounter(
      "mesh_events_total",
      { event_type: eventType },
      1,
      "Total events processed by the mesh",
    );
  }

  recordGoalExecution(goalId: string, status: "success" | "failure"): void {
    this.goalExecutions.add(1, { "goal.id": goalId, status });
    this.registry.incCounter(
      "mesh_goals_executions_total",
      { goal_id: goalId, status },
      1,
      "Goal executions by status",
    );
  }

  recordOperatorDuration(operatorId: string, durationMs: number, status: string): void {
    this.operatorDuration.record(durationMs, {
      "operator.id": operatorId,
      status,
    });
    this.registry.observeHistogram(
      "mesh_operator_duration_ms",
      { operator_id: operatorId, status },
      durationMs,
      "Operator execution duration in milliseconds",
    );
  }

  recordAnomaly(type: string, severity: string): void {
    this.anomaliesDetected.add(1, { type, severity });
    this.registry.incCounter(
      "mesh_anomalies_detected_total",
      { type, severity },
      1,
      "Anomalies detected by the AI detector",
    );
  }

  recordChannelMessage(channelId: string, direction: "inbound" | "outbound"): void {
    this.channelMessages.add(1, { "channel.id": channelId, direction });
    this.registry.incCounter(
      "mesh_channels_messages_total",
      { channel_id: channelId, direction },
      1,
      "Channel messages sent and received",
    );
  }

  /** Return all tracked metrics in Prometheus exposition format. */
  serializePrometheus(): string {
    return this.registry.serialize();
  }

  async shutdown(): Promise<void> {
    await this.provider.shutdown();
  }
}
