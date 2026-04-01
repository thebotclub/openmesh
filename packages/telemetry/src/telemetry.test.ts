import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock pino ──────────────────────────────────────────────────────

const mockChild = vi.fn();
const mockPinoInstance = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: mockChild,
};
mockChild.mockReturnValue(mockPinoInstance);

vi.mock("pino", () => ({
  default: vi.fn(() => mockPinoInstance),
}));

// ── Mock OpenTelemetry SDKs ────────────────────────────────────────

const mockProviderShutdown = vi.fn().mockResolvedValue(undefined);
const mockGetTracer = vi.fn();
const mockSpan = {
  setStatus: vi.fn(),
  end: vi.fn(),
  setAttribute: vi.fn(),
};
const mockStartSpan = vi.fn(() => mockSpan);
mockGetTracer.mockReturnValue({ startSpan: mockStartSpan });

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BasicTracerProvider: vi.fn().mockImplementation(() => ({
    shutdown: mockProviderShutdown,
    getTracer: mockGetTracer,
  })),
  SimpleSpanProcessor: vi.fn(),
}));

const mockMeterProviderShutdown = vi.fn().mockResolvedValue(undefined);
const mockCounter = { add: vi.fn() };
const mockHistogram = { record: vi.fn() };
const mockUpDownCounter = { add: vi.fn() };
const mockMeter = {
  createCounter: vi.fn(() => mockCounter),
  createHistogram: vi.fn(() => mockHistogram),
  createUpDownCounter: vi.fn(() => mockUpDownCounter),
};

vi.mock("@opentelemetry/sdk-metrics", () => ({
  MeterProvider: vi.fn().mockImplementation(() => ({
    shutdown: mockMeterProviderShutdown,
    getMeter: vi.fn(() => mockMeter),
  })),
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: vi.fn(),
}));

vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: vi.fn((attrs: Record<string, string>) => ({
    attributes: attrs,
  })),
}));

vi.mock("@opentelemetry/api", () => ({
  SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2 },
  SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
}));

// ── Imports (after mocks) ──────────────────────────────────────────

import pino from "pino";
import { createLogger, pinoToMeshLogger } from "./logger.js";
import { MeshTracer } from "./tracer.js";
import { MeshMetrics } from "./metrics.js";
import { MeshTelemetry } from "./telemetry.js";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { MeterProvider } from "@opentelemetry/sdk-metrics";

// ── createLogger ───────────────────────────────────────────────────

describe("createLogger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a pino logger with default options", () => {
    createLogger();
    expect(pino).toHaveBeenCalledWith(
      expect.objectContaining({ name: "openmesh", level: "info" }),
    );
  });

  it("accepts custom name and level", () => {
    createLogger({ name: "my-service", level: "debug" });
    expect(pino).toHaveBeenCalledWith(
      expect.objectContaining({ name: "my-service", level: "debug" }),
    );
  });

  it("enables pretty-printing when requested", () => {
    createLogger({ pretty: true });
    expect(pino).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: { target: "pino-pretty", options: { colorize: true } },
      }),
    );
  });
});

// ── pinoToMeshLogger ───────────────────────────────────────────────

describe("pinoToMeshLogger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChild.mockReturnValue(mockPinoInstance);
  });

  it("maps 'info' level to pino info()", () => {
    const meshLogger = pinoToMeshLogger(mockPinoInstance as any);
    meshLogger("info", "router", "event received");
    expect(mockChild).toHaveBeenCalledWith({ component: "router" });
    expect(mockPinoInstance.info).toHaveBeenCalledWith({}, "event received");
  });

  it("maps 'error' level to pino error()", () => {
    const meshLogger = pinoToMeshLogger(mockPinoInstance as any);
    meshLogger("error", "tracer", "span failed");
    expect(mockPinoInstance.error).toHaveBeenCalledWith({}, "span failed");
  });

  it("maps 'warn' level to pino warn()", () => {
    const meshLogger = pinoToMeshLogger(mockPinoInstance as any);
    meshLogger("warn", "metrics", "threshold exceeded");
    expect(mockPinoInstance.warn).toHaveBeenCalledWith({}, "threshold exceeded");
  });

  it("maps 'debug' level to pino debug()", () => {
    const meshLogger = pinoToMeshLogger(mockPinoInstance as any);
    meshLogger("debug", "core", "processing event");
    expect(mockPinoInstance.debug).toHaveBeenCalledWith({}, "processing event");
  });

  it("falls back to info for unknown log levels", () => {
    const childWithoutTrace = {
      ...mockPinoInstance,
      trace: undefined,
      info: vi.fn(),
      child: vi.fn().mockReturnValue({
        ...mockPinoInstance,
        trace: undefined,
        info: vi.fn(),
      }),
    };
    const meshLogger = pinoToMeshLogger(childWithoutTrace as any);
    meshLogger("trace", "core", "detailed");
    const child = childWithoutTrace.child.mock.results[0]!.value;
    expect(child.info).toHaveBeenCalledWith({}, "[trace] detailed");
  });

  it("passes extra args when provided", () => {
    const meshLogger = pinoToMeshLogger(mockPinoInstance as any);
    meshLogger("info", "router", "event received", { detail: 1 });
    expect(mockPinoInstance.info).toHaveBeenCalledWith(
      { extra: [{ detail: 1 }] },
      "event received",
    );
  });
});

// ── MeshTracer ─────────────────────────────────────────────────────

describe("MeshTracer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartSpan.mockReturnValue(mockSpan);
  });

  it("creates a BasicTracerProvider with service name", () => {
    new MeshTracer({ serviceName: "test-mesh" });
    expect(BasicTracerProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: expect.objectContaining({
          attributes: expect.objectContaining({ "service.name": "test-mesh" }),
        }),
      }),
    );
  });

  it("uses default service name 'openmesh'", () => {
    new MeshTracer();
    expect(BasicTracerProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: expect.objectContaining({
          attributes: expect.objectContaining({ "service.name": "openmesh" }),
        }),
      }),
    );
  });

  it("startEventSpan returns a span with event attributes", () => {
    const tracer = new MeshTracer();
    const span = tracer.startEventSpan("github.push", "evt-1");
    expect(mockStartSpan).toHaveBeenCalledWith("event:github.push", {
      kind: 0, // SpanKind.INTERNAL
      attributes: {
        "mesh.event.type": "github.push",
        "mesh.event.id": "evt-1",
      },
    });
    expect(span).toBe(mockSpan);
  });

  it("startGoalSpan returns a span with goal attributes", () => {
    const tracer = new MeshTracer();
    const span = tracer.startGoalSpan("ci-fix", "github.ci.failed");
    expect(mockStartSpan).toHaveBeenCalledWith("goal:ci-fix", {
      kind: 0,
      attributes: {
        "mesh.goal.id": "ci-fix",
        "mesh.event.type": "github.ci.failed",
      },
    });
    expect(span).toBe(mockSpan);
  });

  it("startOperatorSpan returns a span with operator attributes", () => {
    const tracer = new MeshTracer();
    const span = tracer.startOperatorSpan("code", "ci-fix", "investigate");
    expect(mockStartSpan).toHaveBeenCalledWith("operator:code", {
      kind: 0,
      attributes: {
        "mesh.operator.id": "code",
        "mesh.goal.id": "ci-fix",
        "mesh.step.label": "investigate",
      },
    });
    expect(span).toBe(mockSpan);
  });

  it("failSpan sets ERROR status and ends the span", () => {
    const tracer = new MeshTracer();
    const span = tracer.startEventSpan("x", "1");
    tracer.failSpan(span, "boom");
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: 2, // SpanStatusCode.ERROR
      message: "boom",
    });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it("succeedSpan sets OK status and ends the span", () => {
    const tracer = new MeshTracer();
    const span = tracer.startEventSpan("x", "1");
    tracer.succeedSpan(span);
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: 1 }); // SpanStatusCode.OK
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it("shutdown() delegates to provider.shutdown()", async () => {
    const tracer = new MeshTracer();
    await tracer.shutdown();
    expect(mockProviderShutdown).toHaveBeenCalled();
  });
});

// ── MeshMetrics ────────────────────────────────────────────────────

describe("MeshMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a MeterProvider with service name", () => {
    new MeshMetrics({ serviceName: "test-mesh" });
    expect(MeterProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: expect.objectContaining({
          attributes: expect.objectContaining({ "service.name": "test-mesh" }),
        }),
      }),
    );
  });

  it("creates all expected counters and instruments", () => {
    const m = new MeshMetrics();
    expect(m.eventsTotal).toBeDefined();
    expect(m.goalExecutions).toBeDefined();
    expect(m.operatorDuration).toBeDefined();
    expect(m.activeGoals).toBeDefined();
    expect(m.anomaliesDetected).toBeDefined();
    expect(m.channelMessages).toBeDefined();
  });

  it("registers counters and histograms on the meter", () => {
    new MeshMetrics();
    expect(mockMeter.createCounter).toHaveBeenCalledWith(
      "mesh.events.total",
      expect.any(Object),
    );
    expect(mockMeter.createCounter).toHaveBeenCalledWith(
      "mesh.goals.executions",
      expect.any(Object),
    );
    expect(mockMeter.createHistogram).toHaveBeenCalledWith(
      "mesh.operator.duration_ms",
      expect.any(Object),
    );
    expect(mockMeter.createUpDownCounter).toHaveBeenCalledWith(
      "mesh.goals.active",
      expect.any(Object),
    );
  });

  it("shutdown() delegates to provider.shutdown()", async () => {
    const m = new MeshMetrics();
    await m.shutdown();
    expect(mockMeterProviderShutdown).toHaveBeenCalled();
  });
});

// ── MeshTelemetry ──────────────────────────────────────────────────

describe("MeshTelemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChild.mockReturnValue(mockPinoInstance);
  });

  it("creates logger, tracer, and metrics with defaults", () => {
    const tel = new MeshTelemetry();
    expect(tel.logger).toBeDefined();
    expect(tel.meshLogger).toBeTypeOf("function");
    expect(tel.tracer).toBeInstanceOf(MeshTracer);
    expect(tel.metrics).toBeInstanceOf(MeshMetrics);
  });

  it("passes serviceName through to sub-components", () => {
    new MeshTelemetry({ serviceName: "custom" });
    expect(pino).toHaveBeenCalledWith(
      expect.objectContaining({ name: "custom" }),
    );
    expect(BasicTracerProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: expect.objectContaining({
          attributes: expect.objectContaining({ "service.name": "custom" }),
        }),
      }),
    );
  });

  it("disables tracing when enableTracing is false", () => {
    const tel = new MeshTelemetry({ enableTracing: false });
    expect(tel.tracer).toBeUndefined();
    expect(tel.metrics).toBeInstanceOf(MeshMetrics);
  });

  it("disables metrics when enableMetrics is false", () => {
    const tel = new MeshTelemetry({ enableMetrics: false });
    expect(tel.metrics).toBeUndefined();
    expect(tel.tracer).toBeInstanceOf(MeshTracer);
  });

  it("disables both tracing and metrics", () => {
    const tel = new MeshTelemetry({ enableTracing: false, enableMetrics: false });
    expect(tel.tracer).toBeUndefined();
    expect(tel.metrics).toBeUndefined();
    expect(tel.logger).toBeDefined();
  });

  it("shutdown() calls tracer and metrics shutdown", async () => {
    const tel = new MeshTelemetry();
    await tel.shutdown();
    expect(mockProviderShutdown).toHaveBeenCalled();
    expect(mockMeterProviderShutdown).toHaveBeenCalled();
  });

  it("shutdown() succeeds when tracing/metrics disabled", async () => {
    const tel = new MeshTelemetry({ enableTracing: false, enableMetrics: false });
    await expect(tel.shutdown()).resolves.toBeUndefined();
  });
});
