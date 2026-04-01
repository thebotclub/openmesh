import { defineOperator } from "@openmesh/sdk";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, extname } from "node:path";

/**
 * Data Operator — queries files, aggregates metrics, generates reports.
 *
 * Task format:
 *   - "read: <path>" → reads and returns file content
 *   - "count: <dir> [ext]" → counts files in directory
 *   - "grep: <pattern> in <path>" → searches for pattern in file
 *   - "stats: <dir>" → disk usage / file count summary
 *   - otherwise → returns a structured summary of what data ops are available
 */
export default defineOperator({
  id: "data",
  name: "Data Operator",
  description: "Queries files, aggregates metrics, generates reports",
  async execute(ctx) {
    ctx.log(`Data task: ${ctx.task}`);

    // read: <path>
    const readMatch = /^read:\s*(.+)$/im.exec(ctx.task);
    if (readMatch) {
      const filePath = resolve(readMatch[1]!.trim());
      if (!existsSync(filePath)) {
        return {
          status: "failure" as const,
          summary: `File not found: ${filePath}`,
        };
      }
      try {
        const content = readFileSync(filePath, "utf-8");
        return {
          status: "success" as const,
          summary: `Read ${filePath} (${content.length} chars)`,
          data: {
            path: filePath,
            content: content.slice(0, 5000),
            size: content.length,
            truncated: content.length > 5000,
          },
        };
      } catch (err) {
        return {
          status: "failure" as const,
          summary: `Error reading ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // count: <dir> [ext]
    const countMatch = /^count:\s*(\S+)(?:\s+(\.\w+))?$/im.exec(ctx.task);
    if (countMatch) {
      const dir = resolve(countMatch[1]!.trim());
      const ext = countMatch[2]?.trim();
      if (!existsSync(dir)) {
        return { status: "failure" as const, summary: `Directory not found: ${dir}` };
      }
      const files = readdirSync(dir, { recursive: true }) as string[];
      const filtered = ext ? files.filter((f) => extname(String(f)) === ext) : files;
      return {
        status: "success" as const,
        summary: `Found ${filtered.length} file(s) in ${dir}${ext ? ` matching ${ext}` : ""}`,
        data: { directory: dir, count: filtered.length, extension: ext ?? "all" },
      };
    }

    // grep: <pattern> in <path>
    const grepMatch = /^grep:\s*(.+?)\s+in\s+(.+)$/im.exec(ctx.task);
    if (grepMatch) {
      const pattern = grepMatch[1]!.trim();
      const filePath = resolve(grepMatch[2]!.trim());
      if (!existsSync(filePath)) {
        return { status: "failure" as const, summary: `File not found: ${filePath}` };
      }
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      const matches = lines
        .map((line, i) => ({ line: i + 1, text: line }))
        .filter((l) => l.text.includes(pattern));

      return {
        status: "success" as const,
        summary: `Found ${matches.length} match(es) for "${pattern}" in ${filePath}`,
        data: {
          pattern,
          path: filePath,
          matchCount: matches.length,
          matches: matches.slice(0, 20).map((m) => `${m.line}: ${m.text.trim()}`),
        },
      };
    }

    // stats: <dir>
    const statsMatch = /^stats:\s*(.+)$/im.exec(ctx.task);
    if (statsMatch) {
      const dir = resolve(statsMatch[1]!.trim());
      if (!existsSync(dir)) {
        return { status: "failure" as const, summary: `Directory not found: ${dir}` };
      }
      const entries = readdirSync(dir);
      let totalSize = 0;
      let fileCount = 0;
      let dirCount = 0;
      for (const entry of entries) {
        try {
          const st = statSync(join(dir, entry));
          if (st.isDirectory()) dirCount++;
          else { fileCount++; totalSize += st.size; }
        } catch { /* skip */ }
      }
      return {
        status: "success" as const,
        summary: `${dir}: ${fileCount} files, ${dirCount} dirs, ${(totalSize / 1024).toFixed(1)} KB`,
        data: { directory: dir, fileCount, dirCount, totalSizeBytes: totalSize },
      };
    }

    // Fallback: explain available commands
    return {
      status: "success" as const,
      summary: `Data operator ready. Commands: read:<path>, count:<dir> [.ext], grep:<pattern> in <path>, stats:<dir>`,
      data: {
        availableCommands: ["read", "count", "grep", "stats"],
        task: ctx.task,
      },
    };
  },
});
