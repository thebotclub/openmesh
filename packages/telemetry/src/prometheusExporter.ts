/**
 * PrometheusExporter — serves mesh metrics in Prometheus exposition format.
 *
 * Zero external dependencies: uses node:http directly to serve a /metrics
 * endpoint that Prometheus can scrape. Metrics are formatted per the
 * Prometheus exposition format specification.
 *
 * @see https://prometheus.io/docs/instrumenting/exposition_formats/
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface PrometheusExporterConfig {
  /** Port to serve metrics on (default: 9090) */
  port?: number;
  /** Hostname to bind (default: "0.0.0.0") */
  hostname?: string;
  /** Path for metrics endpoint (default: "/metrics") */
  path?: string;
}

/**
 * Lightweight HTTP server that responds to GET /metrics with
 * Prometheus-formatted text from a pluggable metrics provider.
 */
export class PrometheusMetricsServer {
  private httpServer: ReturnType<typeof createServer> | null = null;
  private metricsGetter: (() => string) | null = null;

  constructor(private config: PrometheusExporterConfig = {}) {}

  /**
   * Register a function that returns the current metrics in Prometheus format.
   * Called on each /metrics request.
   */
  setMetricsProvider(getter: () => string): void {
    this.metricsGetter = getter;
  }

  /** Start the HTTP server. Resolves with the bound port. */
  async start(): Promise<{ port: number }> {
    const port = this.config.port ?? 9090;
    const hostname = this.config.hostname ?? "0.0.0.0";
    const metricsPath = this.config.path ?? "/metrics";

    this.httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && req.url === metricsPath) {
        const body = this.metricsGetter?.() ?? "";
        res.writeHead(200, {
          "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        });
        res.end(body);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found\n");
      }
    });

    return new Promise((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(port, hostname, () => {
        const addr = this.httpServer!.address();
        const boundPort = typeof addr === "object" && addr ? addr.port : port;
        resolve({ port: boundPort });
      });
    });
  }

  /** Gracefully stop the HTTP server. */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.httpServer) {
        resolve();
        return;
      }
      this.httpServer.close((err) => {
        this.httpServer = null;
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

// ── Label helpers ──────────────────────────────────────────────────

/** Escape a label value per Prometheus spec: \ → \\, " → \", \n → \\n */
function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Format a label set as `{key="val",key2="val2"}`, or empty string if none. */
function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const parts = entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
  return `{${parts.join(",")}}`;
}

// ── MetricsRegistry ────────────────────────────────────────────────

interface CounterEntry {
  value: number;
  labels: Record<string, string>;
  help: string;
}

interface GaugeEntry {
  value: number;
  labels: Record<string, string>;
  help: string;
}

interface HistogramEntry {
  sum: number;
  count: number;
  labels: Record<string, string>;
  help: string;
}

/**
 * In-process metrics registry that serializes to Prometheus exposition format.
 *
 * Counters, gauges, and histograms are stored in memory and rendered on demand.
 * Each metric name maps to an array of label-distinct time series.
 */
export class MetricsRegistry {
  private counters = new Map<string, CounterEntry[]>();
  private gauges = new Map<string, GaugeEntry[]>();
  private histograms = new Map<string, HistogramEntry[]>();

  /** Increment a counter (creates it if absent). */
  incCounter(
    name: string,
    labels: Record<string, string>,
    value = 1,
    help = "",
  ): void {
    const series = this.counters.get(name) ?? [];
    const existing = series.find((e) => labelsEqual(e.labels, labels));
    if (existing) {
      existing.value += value;
      if (help) existing.help = help;
    } else {
      series.push({ value, labels, help });
      this.counters.set(name, series);
    }
  }

  /** Set a gauge to an absolute value. */
  setGauge(
    name: string,
    labels: Record<string, string>,
    value: number,
    help = "",
  ): void {
    const series = this.gauges.get(name) ?? [];
    const existing = series.find((e) => labelsEqual(e.labels, labels));
    if (existing) {
      existing.value = value;
      if (help) existing.help = help;
    } else {
      series.push({ value, labels, help });
      this.gauges.set(name, series);
    }
  }

  /** Record a histogram observation (sum + count only — no bucket support). */
  observeHistogram(
    name: string,
    labels: Record<string, string>,
    value: number,
    help = "",
  ): void {
    const series = this.histograms.get(name) ?? [];
    const existing = series.find((e) => labelsEqual(e.labels, labels));
    if (existing) {
      existing.sum += value;
      existing.count += 1;
      if (help) existing.help = help;
    } else {
      series.push({ sum: value, count: 1, labels, help });
      this.histograms.set(name, series);
    }
  }

  /** Serialize every registered metric to Prometheus exposition format. */
  serialize(): string {
    const lines: string[] = [];

    for (const [name, entries] of this.counters) {
      const help = entries[0]?.help;
      if (help) lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      for (const e of entries) {
        lines.push(`${name}${formatLabels(e.labels)} ${e.value}`);
      }
    }

    for (const [name, entries] of this.gauges) {
      const help = entries[0]?.help;
      if (help) lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      for (const e of entries) {
        lines.push(`${name}${formatLabels(e.labels)} ${e.value}`);
      }
    }

    for (const [name, entries] of this.histograms) {
      const help = entries[0]?.help;
      if (help) lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const e of entries) {
        const lbl = formatLabels(e.labels);
        lines.push(`${name}_sum${lbl} ${e.sum}`);
        lines.push(`${name}_count${lbl} ${e.count}`);
      }
    }

    return lines.length > 0 ? lines.join("\n") + "\n" : "";
  }
}

/** Deep-equal for flat string→string label objects. */
function labelsEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}
