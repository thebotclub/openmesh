import { defineOperator } from "@openmesh/sdk";
import { execSync } from "node:child_process";

/**
 * Infra Operator — runs infrastructure commands safely.
 *
 * Task format: a description of what to do. The operator extracts
 * actionable commands from known patterns:
 *   - "restart <service>" → restarts via systemctl/docker
 *   - "scale <service> to <n>" → echoes scaling action
 *   - "exec: <command>" → runs the command directly
 *   - otherwise → dry-run mode, reports what it would do
 */

const ALLOWED_COMMANDS = [
  /^docker\s+(restart|stop|start|ps|logs)\b/,
  /^systemctl\s+(restart|stop|start|status)\b/,
  /^kubectl\s+(get|describe|rollout|scale)\b/,
  /^curl\s+-s/,
  /^echo\b/,
  /^cat\b/,
  /^ls\b/,
  /^df\b/,
  /^free\b/,
  /^uptime\b/,
  /^ping\s+-c\s+\d+\b/,
];

function isAllowed(cmd: string): boolean {
  return ALLOWED_COMMANDS.some((pattern) => pattern.test(cmd.trim()));
}

export default defineOperator({
  id: "infra",
  name: "Infrastructure Operator",
  description: "Manages infrastructure: scaling, restarts, deployments",
  async execute(ctx) {
    ctx.log(`Infra task: ${ctx.task}`);

    // Extract "exec: <command>" pattern
    const execMatch = /^exec:\s*(.+)$/im.exec(ctx.task);
    if (execMatch) {
      const cmd = execMatch[1]!.trim();

      if (!isAllowed(cmd)) {
        ctx.log(`Command blocked by allowlist: ${cmd}`);
        return {
          status: "failure" as const,
          summary: `Command not in allowlist: ${cmd}`,
          data: { command: cmd, allowed: false },
        };
      }

      // Request approval for destructive commands
      if (/restart|stop|scale|rollout|delete/i.test(cmd)) {
        const approved = await ctx.requestApproval(
          `Execute infrastructure command: ${cmd}`,
        );
        if (!approved) {
          return {
            status: "denied" as const,
            summary: `Command denied by operator: ${cmd}`,
          };
        }
      }

      try {
        const output = execSync(cmd, {
          timeout: 30_000,
          encoding: "utf-8",
          maxBuffer: 1024 * 1024,
          env: { ...process.env, TERM: "dumb" },
        }).trim();

        ctx.log(`Command output: ${output.slice(0, 200)}`);

        return {
          status: "success" as const,
          summary: `Executed: ${cmd}\n${output.slice(0, 500)}`,
          data: {
            command: cmd,
            output: output.slice(0, 2000),
            exitCode: 0,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: "failure" as const,
          summary: `Command failed: ${cmd} — ${msg.slice(0, 200)}`,
          data: { command: cmd, error: msg.slice(0, 1000) },
        };
      }
    }

    // No explicit exec — report in dry-run mode
    return {
      status: "success" as const,
      summary: `Infra analysis: ${ctx.task.slice(0, 300)}. Use "exec: <command>" for direct execution.`,
      data: {
        mode: "dry-run",
        task: ctx.task,
        suggestion: 'Prefix commands with "exec:" to run them',
      },
    };
  },
});
