/**
 * @openmesh/telemetry — OpenTelemetry + Pino structured logging.
 *
 * Instead of building custom metrics and logging, we use the standard
 * observability stack that every production system uses:
 *   - OpenTelemetry for traces and metrics (exportable to Jaeger, Grafana, Datadog)
 *   - Pino for structured JSON logging (fastest Node.js logger)
 *
 * This gives OpenMesh instant compatibility with:
 *   - Grafana + Prometheus
 *   - Jaeger / Zipkin
 *   - Datadog APM
 *   - AWS CloudWatch / X-Ray
 *   - Any OTLP-compatible backend
 */

export { MeshTelemetry, type TelemetryConfig } from "./telemetry.js";
export { createLogger, type MeshPinoLogger } from "./logger.js";
export { MeshTracer } from "./tracer.js";
export { MeshMetrics } from "./metrics.js";
