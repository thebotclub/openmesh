import { defineObserver } from "@openmesh/sdk";
import { randomUUID } from "node:crypto";

export interface CronSchedule {
  /** Cron-style event name to emit */
  event: string;
  /** Interval in milliseconds */
  intervalMs: number;
  /** Payload to include with each tick */
  payload?: Record<string, unknown>;
}

/** Default schedules if none configured */
const defaultSchedules: CronSchedule[] = [
  { event: "cron.tick", intervalMs: 60_000 },
];

export default defineObserver({
  id: "cron",
  name: "Cron Observer",
  events: ["cron.tick", "cron.daily", "cron.hourly", "cron.custom"],

  async watch(ctx) {
    const schedules = defaultSchedules;
    const timers: ReturnType<typeof setInterval>[] = [];

    for (const schedule of schedules) {
      ctx.log(`Scheduling "${schedule.event}" every ${schedule.intervalMs}ms`);

      const tick = async () => {
        if (ctx.signal.aborted) return;
        await ctx.emit({
          id: randomUUID(),
          type: schedule.event,
          timestamp: new Date().toISOString(),
          source: "cron",
          payload: {
            ...schedule.payload,
            scheduledAt: new Date().toISOString(),
          },
        });
      };

      // Emit first tick immediately
      await tick();

      const timer = setInterval(() => {
        tick().catch((err) => ctx.log(`Cron tick error: ${err}`));
      }, schedule.intervalMs);
      timers.push(timer);
    }

    // Wait until aborted
    await new Promise<void>((resolve) => {
      ctx.signal.addEventListener("abort", () => {
        for (const t of timers) clearInterval(t);
        resolve();
      }, { once: true });
    });
  },
});
