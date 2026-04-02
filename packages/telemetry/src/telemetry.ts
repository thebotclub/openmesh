/**
 * MeshTelemetry — combined telemetry setup for OpenMesh.
 *
 * One-call initialization that sets up tracing, metrics, and logging.
 * Pass the resulting logger to the Mesh constructor.
 */

import { MeshTracer } from "./tracer.js";
import { MeshMetrics } from "./metrics.js";
import { PrometheusMetricsServer } from "./prometheusExporter.js";
import { createLogger, pinoToMeshLogger, type MeshPinoLogger } from "./logger.js";
import type { MeshLogger } from "@openmesh/core";

export interface TelemetryConfig {
  /** Service name for OTLP (default: "openmesh") */
  serviceName?: string;
  /** OTLP endpoint for traces */
  otlpEndpoint?: string;
  /** Log level (default: "info") */
  logLevel?: string;
  /** Pretty-print logs in dev (default: false) */
  prettyLogs?: boolean;
  /** Enable tracing (default: true) */
  enableTracing?: boolean;
  /** Enable metrics (default: true) */
  enableMetrics?: boolean;
  /** Port for the Prometheus /metrics endpoint (omit to disable) */
  prometheusPort?: number;
}

export class MeshTelemetry {
  readonly logger: MeshPinoLogger;
  readonly meshLogger: MeshLogger;
  readonly tracer?: MeshTracer;
  readonly metrics?: MeshMetrics;
  private prometheusServer?: PrometheusMetricsServer;

  constructor(config?: TelemetryConfig) {
    this.logger = createLogger({
      name: config?.serviceName,
      level: config?.logLevel,
      pretty: config?.prettyLogs,
    });

    this.meshLogger = pinoToMeshLogger(this.logger);

    if (config?.enableTracing !== false) {
      this.tracer = new MeshTracer({
        serviceName: config?.serviceName,
        otlpEndpoint: config?.otlpEndpoint,
      });
    }

    if (config?.enableMetrics !== false) {
      this.metrics = new MeshMetrics({
        serviceName: config?.serviceName,
      });
    }

    if (config?.prometheusPort !== undefined && this.metrics) {
      this.prometheusServer = new PrometheusMetricsServer({
        port: config.prometheusPort,
      });
      this.prometheusServer.setMetricsProvider(() => this.metrics!.serializePrometheus());
    }
  }

  /** Start the Prometheus HTTP server (no-op if not configured). */
  async startPrometheus(): Promise<{ port: number } | undefined> {
    return this.prometheusServer?.start();
  }

  /** Stop the Prometheus HTTP server. */
  async stopPrometheus(): Promise<void> {
    await this.prometheusServer?.stop();
  }

  async shutdown(): Promise<void> {
    await this.stopPrometheus();
    await this.tracer?.shutdown();
    await this.metrics?.shutdown();
  }
}
