/**
 * AnomalyDetector — LLM-powered anomaly detection on event streams.
 *
 * Watches the EventBus for patterns that indicate emerging problems:
 *   - Frequency spikes (sudden burst of errors)
 *   - Novel event patterns (types never seen before)
 *   - Correlation detection (A always follows B)
 *   - Drift detection (metric values changing over time)
 *
 * Uses a sliding window + periodic LLM analysis instead of
 * trying to do real-time inference on every event.
 */

import type { ObservationEvent } from "@openmesh/core";
import { AIEngine } from "./engine.js";

export interface Anomaly {
  type: "frequency_spike" | "novel_pattern" | "correlation" | "drift" | "cascade";
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  relatedEvents: string[];
  suggestedAction?: string;
  detectedAt: string;
}

interface WindowEntry {
  type: string;
  timestamp: number;
  source: string;
}

const DETECTOR_SYSTEM = `You are the OpenMesh Anomaly Detector. Analyze the recent event window
and identify any concerning patterns.

Look for:
1. FREQUENCY SPIKES: unusual burst of errors or specific event types
2. NOVEL PATTERNS: event types or combinations not seen in the baseline
3. CORRELATIONS: suspicious A→B patterns (e.g., deploy followed by errors)
4. DRIFT: gradual changes in event frequency or type distribution
5. CASCADE: failures spreading across multiple systems

Respond with JSON:
{
  "anomalies": [
    {
      "type": "frequency_spike|novel_pattern|correlation|drift|cascade",
      "severity": "low|medium|high|critical",
      "description": "what's happening",
      "relatedEvents": ["event.type.1", "event.type.2"],
      "suggestedAction": "what to do about it"
    }
  ],
  "summary": "overall assessment"
}

If nothing unusual, return { "anomalies": [], "summary": "normal" }.`;

export class AnomalyDetector {
  private window: WindowEntry[] = [];
  private windowSizeMs: number;
  private analysisIntervalMs: number;
  private baseline: Map<string, number> = new Map();
  private analysisTimer?: ReturnType<typeof setInterval>;

  constructor(
    private ai: AIEngine,
    private onAnomaly: (anomaly: Anomaly) => void,
    options?: {
      /** Window size for analysis (default: 5 minutes) */
      windowSizeMs?: number;
      /** How often to run analysis (default: 60 seconds) */
      analysisIntervalMs?: number;
    },
  ) {
    this.windowSizeMs = options?.windowSizeMs ?? 5 * 60 * 1000;
    this.analysisIntervalMs = options?.analysisIntervalMs ?? 60 * 1000;
  }

  /** Feed an event into the detector */
  observe(event: ObservationEvent): void {
    const now = Date.now();
    this.window.push({
      type: event.type,
      timestamp: now,
      source: event.source,
    });

    // Update baseline frequencies
    const count = this.baseline.get(event.type) ?? 0;
    this.baseline.set(event.type, count + 1);

    // Trim old entries
    const cutoff = now - this.windowSizeMs;
    this.window = this.window.filter((e) => e.timestamp > cutoff);
  }

  /** Start periodic analysis */
  start(): void {
    this.analysisTimer = setInterval(() => {
      this.analyze().catch((err) => {
        console.error("[anomaly-detector] Analysis failed:", err);
      });
    }, this.analysisIntervalMs);
  }

  /** Stop periodic analysis */
  stop(): void {
    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
      this.analysisTimer = undefined;
    }
  }

  /** Run a single analysis of the current window */
  async analyze(): Promise<Anomaly[]> {
    if (this.window.length < 3) return [];

    // Build frequency summary
    const freqMap = new Map<string, number>();
    for (const entry of this.window) {
      freqMap.set(entry.type, (freqMap.get(entry.type) ?? 0) + 1);
    }

    const windowSummary = [...freqMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `  ${type}: ${count} events`)
      .join("\n");

    const baselineSummary = [...this.baseline.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([type, count]) => `  ${type}: ${count} total`)
      .join("\n");

    const prompt = `Window (last ${Math.round(this.windowSizeMs / 1000)}s, ${this.window.length} events):
${windowSummary}

Baseline totals (all-time):
${baselineSummary}

Event timeline (last 20):
${this.window
  .slice(-20)
  .map((e) => `  ${new Date(e.timestamp).toISOString()} ${e.type} [${e.source}]`)
  .join("\n")}`;

    const result = await this.ai.promptJSON<{
      anomalies: Anomaly[];
      summary: string;
    }>(DETECTOR_SYSTEM, prompt);

    const now = new Date().toISOString();
    for (const anomaly of result.anomalies) {
      anomaly.detectedAt = now;
      this.onAnomaly(anomaly);
    }

    return result.anomalies;
  }
}
