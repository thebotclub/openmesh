import { defineOperator } from "@openmesh/sdk";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { execSync } from "node:child_process";

/**
 * Code Operator — investigates source code, runs analysis, and reports findings.
 *
 * Task format:
 *   - "analyze: <path>" → reads file, reports structure (functions, exports, lines)
 *   - "search: <pattern> in <dir>" → grep-style search across files
 *   - "test: <command>" → runs a test command and reports pass/fail
 *   - "diff: <path>" → shows uncommitted changes via git diff
 *   - otherwise → summarizes the task for human review
 */
export default defineOperator({
  id: "code",
  name: "Code Operator",
  description: "Investigates code issues, runs analysis, reports findings",
  async execute(ctx) {
    ctx.log(`🔍 Code task: ${ctx.task}`);

    // analyze: <path>
    const analyzeMatch = /^analyze:\s*(.+)$/im.exec(ctx.task);
    if (analyzeMatch) {
      const filePath = resolve(analyzeMatch[1]!.trim());
      if (!existsSync(filePath)) {
        return { status: "failure" as const, summary: `File not found: ${filePath}` };
      }
      try {
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        const functions = lines.filter((l) =>
          /^\s*(export\s+)?(async\s+)?function\s+\w+|^\s*(export\s+)?(const|let)\s+\w+\s*=\s*(async\s+)?\(/.test(l),
        );
        const exports = lines.filter((l) => /^export\s/.test(l));
        const imports = lines.filter((l) => /^import\s/.test(l));

        return {
          status: "success" as const,
          summary: `${filePath}: ${lines.length} lines, ${functions.length} functions, ${exports.length} exports, ${imports.length} imports`,
          data: {
            path: filePath,
            lineCount: lines.length,
            functionCount: functions.length,
            exportCount: exports.length,
            importCount: imports.length,
            functions: functions.slice(0, 10).map((l) => l.trim()),
            preview: content.slice(0, 1000),
          },
        };
      } catch (err) {
        return {
          status: "failure" as const,
          summary: `Error analyzing ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // search: <pattern> in <dir>
    const searchMatch = /^search:\s*(.+?)\s+in\s+(.+)$/im.exec(ctx.task);
    if (searchMatch) {
      const pattern = searchMatch[1]!.trim();
      const dir = resolve(searchMatch[2]!.trim());
      if (!existsSync(dir)) {
        return { status: "failure" as const, summary: `Directory not found: ${dir}` };
      }

      const results: Array<{ file: string; line: number; text: string }> = [];
      const codeExts = new Set([".ts", ".js", ".tsx", ".jsx", ".py", ".go", ".rs", ".sh", ".yaml", ".yml", ".json", ".md"]);

      function walkDir(dirPath: string) {
        for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
          const fullPath = join(dirPath, entry.name);
          if (entry.isDirectory()) {
            walkDir(fullPath);
          } else if (codeExts.has(extname(entry.name))) {
            try {
              const content = readFileSync(fullPath, "utf-8");
              const lines = content.split("\n");
              for (let i = 0; i < lines.length; i++) {
                if (lines[i]!.includes(pattern)) {
                  results.push({ file: fullPath, line: i + 1, text: lines[i]!.trim() });
                  if (results.length >= 50) return;
                }
              }
            } catch { /* skip unreadable */ }
          }
        }
      }

      walkDir(dir);

      return {
        status: "success" as const,
        summary: `Found ${results.length} match(es) for "${pattern}" in ${dir}`,
        data: {
          pattern,
          directory: dir,
          matchCount: results.length,
          matches: results.slice(0, 20).map((r) => `${r.file}:${r.line}: ${r.text.slice(0, 100)}`),
        },
      };
    }

    // test: <command>
    const testMatch = /^test:\s*(.+)$/im.exec(ctx.task);
    if (testMatch) {
      const cmd = testMatch[1]!.trim();
      try {
        const output = execSync(cmd, {
          timeout: 60_000,
          encoding: "utf-8",
          maxBuffer: 2 * 1024 * 1024,
        }).trim();

        return {
          status: "success" as const,
          summary: `Tests passed: ${cmd}`,
          data: { command: cmd, output: output.slice(-2000), passed: true },
        };
      } catch (err) {
        const msg = err instanceof Error ? (err as { stderr?: string }).stderr ?? err.message : String(err);
        return {
          status: "failure" as const,
          summary: `Tests failed: ${cmd}\n${String(msg).slice(-500)}`,
          data: { command: cmd, output: String(msg).slice(-2000), passed: false },
        };
      }
    }

    // diff: <path>
    const diffMatch = /^diff:\s*(.+)$/im.exec(ctx.task);
    if (diffMatch) {
      const target = resolve(diffMatch[1]!.trim());
      try {
        const diff = execSync(`git diff -- ${JSON.stringify(target)}`, {
          timeout: 10_000,
          encoding: "utf-8",
          cwd: target,
        }).trim();

        return {
          status: "success" as const,
          summary: diff ? `Uncommitted changes in ${target} (${diff.split("\n").length} lines)` : `No uncommitted changes in ${target}`,
          data: { path: target, diff: diff.slice(0, 3000), hasChanges: !!diff },
        };
      } catch (err) {
        return {
          status: "failure" as const,
          summary: `Git diff failed for ${target}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // Fallback: investigation summary
    return {
      status: "success" as const,
      summary: `Code investigation: ${ctx.task.slice(0, 300)}. Commands: analyze:<path>, search:<pattern> in <dir>, test:<cmd>, diff:<path>`,
      data: {
        availableCommands: ["analyze", "search", "test", "diff"],
        task: ctx.task,
      },
    };
  },
});
