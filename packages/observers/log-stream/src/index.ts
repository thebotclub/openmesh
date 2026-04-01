import { defineObserver } from "@openmesh/sdk";
import { watch, readFileSync, existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** Patterns that indicate an error or anomaly in a log line */
const ERROR_PATTERNS = [
  /\bERROR\b/i,
  /\bFATAL\b/i,
  /\bPANIC\b/i,
  /\bCRITICAL\b/i,
  /\bUnhandledRejection\b/i,
  /\bSegmentation fault\b/i,
  /\bOOM\b/i,
  /\bout of memory\b/i,
];

const WARN_PATTERNS = [
  /\bWARN(ING)?\b/i,
  /\bDEPRECATED\b/i,
  /\btimeout\b/i,
  /\bretry\b/i,
];

function classifyLine(line: string): "error" | "warn" | null {
  for (const p of ERROR_PATTERNS) {
    if (p.test(line)) return "error";
  }
  for (const p of WARN_PATTERNS) {
    if (p.test(line)) return "warn";
  }
  return null;
}

export default defineObserver({
  id: "log-stream",
  name: "Log Stream Observer",
  events: ["log.error", "log.warn", "log.anomaly"],

  async watch(ctx) {
    const logPaths = (process.env.OPENMESH_LOG_PATHS ?? "").split(",").filter(Boolean);

    if (logPaths.length === 0) {
      ctx.log("No log paths configured (set OPENMESH_LOG_PATHS=path1,path2)");
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return;
    }

    const watchers: ReturnType<typeof watch>[] = [];

    for (const logPath of logPaths) {
      if (!existsSync(logPath)) {
        ctx.log(`Log file not found: ${logPath}`);
        continue;
      }

      let offset = statSync(logPath).size; // start from end (tail mode)
      ctx.log(`Tailing ${logPath} from offset ${offset}`);

      const watcher = watch(logPath, async () => {
        if (ctx.signal.aborted) return;
        try {
          const content = readFileSync(logPath, "utf-8");
          const newContent = content.slice(offset);
          offset = content.length;

          if (!newContent.trim()) return;

          const lines = newContent.split("\n").filter(Boolean);
          for (const line of lines) {
            const level = classifyLine(line);
            if (!level) continue;

            await ctx.emit({
              id: randomUUID(),
              type: `log.${level}`,
              timestamp: new Date().toISOString(),
              source: "log-stream",
              payload: {
                file: logPath,
                line: line.trim(),
                level,
              },
              dedupKey: `${logPath}:${line.trim().slice(0, 100)}`,
            });
          }
        } catch (err) {
          ctx.log(`Error reading ${logPath}: ${err}`);
        }
      });

      watchers.push(watcher);
    }

    // Wait until aborted
    await new Promise<void>((resolve) => {
      ctx.signal.addEventListener("abort", () => {
        for (const w of watchers) w.close();
        resolve();
      }, { once: true });
    });
  },
});
