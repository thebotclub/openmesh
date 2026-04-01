import { defineObserver } from "@openmesh/sdk";
import { randomUUID } from "node:crypto";

export interface HealthEndpoint {
  url: string;
  name: string;
  intervalMs?: number;
  timeoutMs?: number;
  expectedStatus?: number;
}

/** Default: no endpoints (configured at runtime) */
const endpoints: HealthEndpoint[] = [];

export { endpoints as configureEndpoints };

export default defineObserver({
  id: "http-health",
  name: "HTTP Health Observer",
  events: [
    "http.health.up",
    "http.health.down",
    "http.health.degraded",
    "http.health.latency-spike",
  ],

  async watch(ctx) {
    if (endpoints.length === 0) {
      ctx.log("No health endpoints configured. Waiting for configuration...");
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return;
    }

    const timers: ReturnType<typeof setInterval>[] = [];

    for (const ep of endpoints) {
      const interval = ep.intervalMs ?? 30_000;
      const timeout = ep.timeoutMs ?? 10_000;
      const expectedStatus = ep.expectedStatus ?? 200;

      ctx.log(`Monitoring ${ep.name} (${ep.url}) every ${interval}ms`);

      const check = async () => {
        if (ctx.signal.aborted) return;
        const start = Date.now();
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          const res = await fetch(ep.url, { signal: controller.signal });
          clearTimeout(timer);
          const latencyMs = Date.now() - start;

          if (res.status === expectedStatus) {
            const eventType = latencyMs > 2000 ? "http.health.degraded" : "http.health.up";
            await ctx.emit({
              id: randomUUID(),
              type: eventType,
              timestamp: new Date().toISOString(),
              source: "http-health",
              payload: { name: ep.name, url: ep.url, status: res.status, latencyMs },
              dedupKey: `${ep.name}:${eventType}`,
            });
          } else {
            await ctx.emit({
              id: randomUUID(),
              type: "http.health.down",
              timestamp: new Date().toISOString(),
              source: "http-health",
              payload: { name: ep.name, url: ep.url, status: res.status, latencyMs },
              dedupKey: `${ep.name}:down`,
            });
          }
        } catch (err) {
          await ctx.emit({
            id: randomUUID(),
            type: "http.health.down",
            timestamp: new Date().toISOString(),
            source: "http-health",
            payload: {
              name: ep.name,
              url: ep.url,
              error: err instanceof Error ? err.message : String(err),
              latencyMs: Date.now() - start,
            },
            dedupKey: `${ep.name}:down`,
          });
        }
      };

      await check();
      const timer = setInterval(() => {
        check().catch((e) => ctx.log(`Health check error for ${ep.name}: ${e}`));
      }, interval);
      timers.push(timer);
    }

    await new Promise<void>((resolve) => {
      ctx.signal.addEventListener("abort", () => {
        for (const t of timers) clearInterval(t);
        resolve();
      }, { once: true });
    });
  },
});
