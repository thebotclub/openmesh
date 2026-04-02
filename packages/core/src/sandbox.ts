import { execSync, type ExecSyncOptions } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SandboxConfig {
  /** Enable sandbox (default: true) */
  enabled?: boolean;
  /** Working directory for sandboxed commands. If not set, creates a tmpdir */
  workDir?: string;
  /** Command timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Max output buffer in bytes (default: 1MB) */
  maxBuffer?: number;
  /** Environment variables to pass through (exact names, not patterns) */
  envAllowlist?: string[];
  /** Additional env vars to set */
  envOverrides?: Record<string, string>;
}

export interface SandboxResult {
  stdout: string;
  exitCode: number;
  timedOut: boolean;
  workDir: string;
}

// Default env vars that are safe to pass through
const DEFAULT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "NODE_ENV",
  "TZ",
];

// Dangerous patterns that should never be executed even if allowed
const DANGEROUS_PATTERNS = [
  /rm\s+(-rf?|--recursive)?\s*\//i, // rm -rf /
  /:\(\)\{\s*:\|:\s*&\s*\};:/, // fork bomb
  />(\/dev\/sd|\/dev\/hd)/i, // write to disk device
  /mkfs\./i, // format filesystem
  /dd\s+if=/i, // raw disk ops
  /shutdown|reboot|halt|poweroff/i, // system power
];

/**
 * Sandbox for safe command execution with environment isolation,
 * working directory isolation, and resource limits.
 *
 * Borrowed from OpenClaw's subprocess isolation pattern.
 */
export class Sandbox {
  readonly config: Required<SandboxConfig>;
  private tempDirs: string[] = [];

  constructor(config?: SandboxConfig) {
    this.config = {
      enabled: config?.enabled ?? true,
      workDir: config?.workDir ?? "",
      timeoutMs: config?.timeoutMs ?? 30_000,
      maxBuffer: config?.maxBuffer ?? 1024 * 1024,
      envAllowlist: config?.envAllowlist ?? DEFAULT_ENV_ALLOWLIST,
      envOverrides: config?.envOverrides ?? {},
    };
  }

  /**
   * Validate a command against dangerous patterns.
   * Returns the reason it's blocked, or undefined if safe.
   */
  validate(command: string): string | undefined {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return `Blocked by sandbox: command matches dangerous pattern ${pattern}`;
      }
    }
    // Check for shell injection patterns
    if (/;\s*(rm|curl|wget|nc|bash|sh|python|node|eval)\b/.test(command)) {
      return "Blocked by sandbox: potential command injection detected";
    }
    return undefined;
  }

  /**
   * Build a sanitized environment object.
   * Only passes through explicitly allowed env vars + overrides.
   */
  buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};

    // Only copy allowed env vars
    for (const key of this.config.envAllowlist) {
      const val = process.env[key];
      if (val !== undefined) {
        env[key] = val;
      }
    }

    // Apply overrides
    for (const [key, val] of Object.entries(this.config.envOverrides)) {
      env[key] = val;
    }

    return env;
  }

  /**
   * Get or create an isolated working directory.
   */
  getWorkDir(): string {
    if (this.config.workDir) return this.config.workDir;
    const dir = mkdtempSync(join(tmpdir(), "openmesh-sandbox-"));
    this.tempDirs.push(dir);
    return dir;
  }

  /**
   * Execute a command in the sandbox.
   */
  exec(command: string): SandboxResult {
    if (!this.config.enabled) {
      // Sandbox disabled — run directly (but still capture output)
      try {
        const stdout = execSync(command, {
          encoding: "utf-8",
          timeout: this.config.timeoutMs,
          maxBuffer: this.config.maxBuffer,
        }).trim();
        return { stdout, exitCode: 0, timedOut: false, workDir: process.cwd() };
      } catch (err: any) {
        if (err.killed || err.code === "ETIMEDOUT" || err.signal === "SIGTERM")
          return {
            stdout: err.stdout?.trim() ?? "",
            exitCode: 1,
            timedOut: true,
            workDir: process.cwd(),
          };
        return {
          stdout: err.stderr?.trim() ?? err.message,
          exitCode: err.status ?? 1,
          timedOut: false,
          workDir: process.cwd(),
        };
      }
    }

    // Validate command
    const blocked = this.validate(command);
    if (blocked) {
      return { stdout: blocked, exitCode: 1, timedOut: false, workDir: "" };
    }

    const workDir = this.getWorkDir();
    const env = this.buildEnv();

    const options: ExecSyncOptions = {
      encoding: "utf-8",
      timeout: this.config.timeoutMs,
      maxBuffer: this.config.maxBuffer,
      cwd: workDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    };

    try {
      const stdout = execSync(command, options) as unknown as string;
      return { stdout: stdout.trim(), exitCode: 0, timedOut: false, workDir };
    } catch (err: any) {
      const timedOut =
        err.killed === true ||
        err.code === "ETIMEDOUT" ||
        err.signal === "SIGTERM";
      const stdout = (err.stdout?.toString() ?? "").trim();
      const stderr = (err.stderr?.toString() ?? "").trim();
      return {
        stdout: stdout || stderr || err.message,
        exitCode: err.status ?? 1,
        timedOut,
        workDir,
      };
    }
  }

  /**
   * Clean up temporary directories.
   */
  cleanup(): void {
    for (const dir of this.tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup errors */
      }
    }
    this.tempDirs = [];
  }
}
