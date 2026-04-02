import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MetricsRegistry, PrometheusMetricsServer } from "./prometheusExporter.js";

// ── MetricsRegistry ────────────────────────────────────────────────

describe("MetricsRegistry", () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    registry = new MetricsRegistry();
  });

  it("creates a counter entry on incCounter", () => {
    registry.incCounter("http_requests_total", { method: "GET" }, 1, "Total HTTP requests");
    const text = registry.serialize();
    expect(text).toContain("# HELP http_requests_total Total HTTP requests");
    expect(text).toContain("# TYPE http_requests_total counter");
    expect(text).toContain('http_requests_total{method="GET"} 1');
  });

  it("accumulates counter values for the same label set", () => {
    registry.incCounter("c", { x: "1" }, 3);
    registry.incCounter("c", { x: "1" }, 7);
    const text = registry.serialize();
    expect(text).toContain('c{x="1"} 10');
  });

  it("tracks distinct label sets separately", () => {
    registry.incCounter("c", { a: "1" }, 1);
    registry.incCounter("c", { a: "2" }, 5);
    const text = registry.serialize();
    expect(text).toContain('c{a="1"} 1');
    expect(text).toContain('c{a="2"} 5');
  });

  it("creates a gauge entry on setGauge", () => {
    registry.setGauge("cpu_usage", { host: "h1" }, 72.5, "CPU usage percent");
    const text = registry.serialize();
    expect(text).toContain("# HELP cpu_usage CPU usage percent");
    expect(text).toContain("# TYPE cpu_usage gauge");
    expect(text).toContain('cpu_usage{host="h1"} 72.5');
  });

  it("overwrites gauge values for the same label set", () => {
    registry.setGauge("g", {}, 10);
    registry.setGauge("g", {}, 42);
    const text = registry.serialize();
    expect(text).toContain("g 42");
    expect(text).not.toContain("g 10");
  });

  it("creates histogram entries with sum and count", () => {
    registry.observeHistogram("req_duration_ms", { path: "/" }, 100, "Request duration");
    registry.observeHistogram("req_duration_ms", { path: "/" }, 200);
    const text = registry.serialize();
    expect(text).toContain("# HELP req_duration_ms Request duration");
    expect(text).toContain("# TYPE req_duration_ms histogram");
    expect(text).toContain('req_duration_ms_sum{path="/"} 300');
    expect(text).toContain('req_duration_ms_count{path="/"} 2');
  });

  it("escapes special characters in label values", () => {
    registry.incCounter("m", { msg: 'say "hello"\nworld' }, 1);
    const text = registry.serialize();
    expect(text).toContain('msg="say \\"hello\\"\\nworld"');
  });

  it("handles metrics with no labels", () => {
    registry.incCounter("uptime", {}, 1);
    const text = registry.serialize();
    expect(text).toContain("uptime 1");
    expect(text).not.toContain("{}");
  });

  it("returns empty string when no metrics registered", () => {
    expect(registry.serialize()).toBe("");
  });

  it("omits HELP line when help is empty", () => {
    registry.incCounter("no_help", { x: "1" });
    const text = registry.serialize();
    expect(text).not.toContain("# HELP no_help");
    expect(text).toContain("# TYPE no_help counter");
  });
});

// ── PrometheusMetricsServer ────────────────────────────────────────

describe("PrometheusMetricsServer", () => {
  let server: PrometheusMetricsServer;
  let port: number;

  afterEach(async () => {
    await server?.stop();
  });

  it("serves /metrics with correct Content-Type", async () => {
    server = new PrometheusMetricsServer({ port: 0, hostname: "127.0.0.1" });
    server.setMetricsProvider(() => 'mesh_up 1\n');
    const result = await server.start();
    port = result.port;

    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toBe("mesh_up 1\n");
  });

  it("returns 404 for non-metrics paths", async () => {
    server = new PrometheusMetricsServer({ port: 0, hostname: "127.0.0.1" });
    server.setMetricsProvider(() => "");
    const result = await server.start();
    port = result.port;

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(404);
  });

  it("returns empty body when no provider set", async () => {
    server = new PrometheusMetricsServer({ port: 0, hostname: "127.0.0.1" });
    const result = await server.start();
    port = result.port;

    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("supports custom metrics path", async () => {
    server = new PrometheusMetricsServer({ port: 0, hostname: "127.0.0.1", path: "/prom" });
    server.setMetricsProvider(() => "ok\n");
    const result = await server.start();
    port = result.port;

    const res = await fetch(`http://127.0.0.1:${port}/prom`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok\n");
  });
});

// ── MeshMetrics integration ────────────────────────────────────────

describe("MeshMetrics.serializePrometheus", () => {
  // These tests mock OTel so we can unit-test just the Prometheus bridge,
  // but still exercise the real MeshMetrics record* → registry flow.

  // We dynamically import after mocking to avoid hoisting issues
  // with the OTel SDK deps.
  let MeshMetrics: typeof import("./metrics.js").MeshMetrics;

  beforeEach(async () => {
    // Use dynamic import to get the real MeshMetrics — the existing
    // telemetry.test.ts already mocks OTel globally, but these tests
    // run in a separate file so we mock locally.
    const { vi } = await import("vitest");

    vi.doMock("@opentelemetry/sdk-metrics", () => ({
      MeterProvider: vi.fn().mockImplementation(() => ({
        shutdown: vi.fn().mockResolvedValue(undefined),
        getMeter: vi.fn(() => ({
          createCounter: vi.fn(() => ({ add: vi.fn() })),
          createHistogram: vi.fn(() => ({ record: vi.fn() })),
          createUpDownCounter: vi.fn(() => ({ add: vi.fn() })),
        })),
      })),
    }));

    vi.doMock("@opentelemetry/resources", () => ({
      resourceFromAttributes: vi.fn((a: Record<string, string>) => ({ attributes: a })),
    }));

    vi.doMock("@opentelemetry/api", () => ({
      SpanKind: { INTERNAL: 0 },
      SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
    }));

    const mod = await import("./metrics.js");
    MeshMetrics = mod.MeshMetrics;
  });

  it("returns prometheus text after recording events", async () => {
    const m = new MeshMetrics();
    m.recordEvent("tick");
    m.recordEvent("tick");
    m.recordEvent("alert");
    const text = m.serializePrometheus();
    expect(text).toContain("# TYPE mesh_events_total counter");
    expect(text).toContain('mesh_events_total{event_type="tick"} 2');
    expect(text).toContain('mesh_events_total{event_type="alert"} 1');
  });

  it("includes goal executions in prometheus output", async () => {
    const m = new MeshMetrics();
    m.recordGoalExecution("g1", "success");
    m.recordGoalExecution("g1", "failure");
    const text = m.serializePrometheus();
    expect(text).toContain('mesh_goals_executions_total{goal_id="g1",status="success"} 1');
    expect(text).toContain('mesh_goals_executions_total{goal_id="g1",status="failure"} 1');
  });

  it("includes operator duration histograms", async () => {
    const m = new MeshMetrics();
    m.recordOperatorDuration("op1", 120, "ok");
    m.recordOperatorDuration("op1", 80, "ok");
    const text = m.serializePrometheus();
    expect(text).toContain("# TYPE mesh_operator_duration_ms histogram");
    expect(text).toContain('mesh_operator_duration_ms_sum{operator_id="op1",status="ok"} 200');
    expect(text).toContain('mesh_operator_duration_ms_count{operator_id="op1",status="ok"} 2');
  });

  it("integration: events + goals + operators all appear", async () => {
    const m = new MeshMetrics();
    m.recordEvent("data");
    m.recordGoalExecution("g2", "success");
    m.recordOperatorDuration("filter", 50, "ok");
    m.recordAnomaly("spike", "high");
    m.recordChannelMessage("ch1", "inbound");

    const text = m.serializePrometheus();
    expect(text).toContain("mesh_events_total");
    expect(text).toContain("mesh_goals_executions_total");
    expect(text).toContain("mesh_operator_duration_ms");
    expect(text).toContain("mesh_anomalies_detected_total");
    expect(text).toContain("mesh_channels_messages_total");
  });
});
