/**
 * MeshTracer — OpenTelemetry distributed tracing.
 *
 * Traces the entire event → goal → operator pipeline so you can see
 * exactly what happened, how long each step took, and where failures occur.
 */

import { SpanKind, SpanStatusCode, type Tracer, type Span } from "@opentelemetry/api";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";

export class MeshTracer {
  private provider: BasicTracerProvider;
  private tracer: Tracer;

  constructor(options?: {
    serviceName?: string;
    otlpEndpoint?: string;
  }) {
    const serviceName = options?.serviceName ?? "openmesh";
    const endpoint =
      options?.otlpEndpoint ??
      process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ??
      "http://localhost:4318/v1/traces";

    this.provider = new BasicTracerProvider({
      resource: resourceFromAttributes({
        "service.name": serviceName,
        "service.version": "0.1.0",
      }),
      spanProcessors: [
        new SimpleSpanProcessor(
          new OTLPTraceExporter({ url: endpoint }),
        ),
      ],
    });

    this.tracer = this.provider.getTracer(serviceName);
  }

  /** Start a span for event processing */
  startEventSpan(eventType: string, eventId: string): Span {
    return this.tracer.startSpan(`event:${eventType}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        "mesh.event.type": eventType,
        "mesh.event.id": eventId,
      },
    });
  }

  /** Start a span for goal execution */
  startGoalSpan(goalId: string, eventType: string): Span {
    return this.tracer.startSpan(`goal:${goalId}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        "mesh.goal.id": goalId,
        "mesh.event.type": eventType,
      },
    });
  }

  /** Start a span for operator execution */
  startOperatorSpan(operatorId: string, goalId: string, stepLabel: string): Span {
    return this.tracer.startSpan(`operator:${operatorId}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        "mesh.operator.id": operatorId,
        "mesh.goal.id": goalId,
        "mesh.step.label": stepLabel,
      },
    });
  }

  /** Mark a span as failed */
  failSpan(span: Span, error: string): void {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error });
    span.end();
  }

  /** Mark a span as succeeded */
  succeedSpan(span: Span): void {
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  }

  /** Shutdown the tracer (flush pending spans) */
  async shutdown(): Promise<void> {
    await this.provider.shutdown();
  }
}
