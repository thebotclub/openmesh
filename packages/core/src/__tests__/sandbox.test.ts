import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { Sandbox, type SandboxConfig } from "../sandbox.js";
import { Mesh } from "../runtime/mesh.js";

// ── Validation ──────────────────────────────────────────────────────

describe("Sandbox.validate", () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = new Sandbox();
  });

  it("blocks rm -rf /", () => {
    expect(sb.validate("rm -rf /")).toBeDefined();
  });

  it("blocks rm -r /tmp/foo variant with root path", () => {
    expect(sb.validate("rm -r /")).toBeDefined();
  });

  it("blocks fork bombs", () => {
    expect(sb.validate(":(){ :|:& };:")).toBeDefined();
  });

  it("blocks disk device writes", () => {
    expect(sb.validate("echo bad >/dev/sda")).toBeDefined();
    expect(sb.validate("echo bad >/dev/hda")).toBeDefined();
  });

  it("blocks mkfs commands", () => {
    expect(sb.validate("mkfs.ext4 /dev/sda1")).toBeDefined();
  });

  it("blocks dd if= commands", () => {
    expect(sb.validate("dd if=/dev/zero of=/dev/sda")).toBeDefined();
  });

  it("blocks shutdown/reboot/halt/poweroff", () => {
    expect(sb.validate("shutdown -h now")).toBeDefined();
    expect(sb.validate("reboot")).toBeDefined();
    expect(sb.validate("halt")).toBeDefined();
    expect(sb.validate("poweroff")).toBeDefined();
  });

  it("blocks command injection via ;rm", () => {
    expect(sb.validate("echo hi; rm -rf /tmp")).toBeDefined();
  });

  it("blocks command injection via ;curl", () => {
    expect(sb.validate("ls; curl evil.com")).toBeDefined();
  });

  it("blocks command injection via ;bash", () => {
    expect(sb.validate("echo x; bash -c 'bad'")).toBeDefined();
  });

  it("allows normal echo command", () => {
    expect(sb.validate("echo hello")).toBeUndefined();
  });

  it("allows ls command", () => {
    expect(sb.validate("ls -la")).toBeUndefined();
  });

  it("allows cat command", () => {
    expect(sb.validate("cat /etc/hostname")).toBeUndefined();
  });

  it("returns a reason string when blocked", () => {
    const reason = sb.validate("rm -rf /");
    expect(typeof reason).toBe("string");
    expect(reason).toContain("Blocked by sandbox");
  });
});

// ── Environment ─────────────────────────────────────────────────────

describe("Sandbox.buildEnv", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save original values
    for (const k of [
      "PATH",
      "HOME",
      "OPENMESH_LLM_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "MY_SECRET_TOKEN",
      "NODE_ENV",
    ]) {
      savedEnv[k] = process.env[k];
    }
  });

  afterEach(() => {
    // Restore original values
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("only includes allowlisted vars", () => {
    process.env.OPENMESH_LLM_API_KEY = "super-secret";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-secret";

    const sb = new Sandbox();
    const env = sb.buildEnv();

    expect(env.OPENMESH_LLM_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("includes PATH and HOME from allowlist", () => {
    const sb = new Sandbox();
    const env = sb.buildEnv();

    // PATH and HOME should be present (they exist on macOS)
    expect(env.PATH).toBeDefined();
    expect(env.HOME).toBeDefined();
  });

  it("includes overrides", () => {
    const sb = new Sandbox({ envOverrides: { MY_VAR: "hello" } });
    const env = sb.buildEnv();
    expect(env.MY_VAR).toBe("hello");
  });

  it("overrides take precedence over env vars", () => {
    process.env.NODE_ENV = "production";
    const sb = new Sandbox({ envOverrides: { NODE_ENV: "test" } });
    const env = sb.buildEnv();
    expect(env.NODE_ENV).toBe("test");
  });

  it("strips OPENMESH_LLM_API_KEY", () => {
    process.env.OPENMESH_LLM_API_KEY = "key123";
    const sb = new Sandbox();
    const env = sb.buildEnv();
    expect(env.OPENMESH_LLM_API_KEY).toBeUndefined();
  });

  it("strips AWS_SECRET_ACCESS_KEY", () => {
    process.env.AWS_SECRET_ACCESS_KEY = "awskey";
    const sb = new Sandbox();
    const env = sb.buildEnv();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("strips arbitrary non-allowlisted vars", () => {
    process.env.MY_SECRET_TOKEN = "tok";
    const sb = new Sandbox();
    const env = sb.buildEnv();
    expect(env.MY_SECRET_TOKEN).toBeUndefined();
  });
});

// ── Execution (enabled) ─────────────────────────────────────────────

describe("Sandbox.exec (enabled)", () => {
  let sb: Sandbox;

  afterEach(() => {
    sb?.cleanup();
  });

  it("runs a command and returns stdout", () => {
    sb = new Sandbox();
    const result = sb.exec("echo hello");
    expect(result.stdout).toBe("hello");
  });

  it("returns exitCode 0 on success", () => {
    sb = new Sandbox();
    const result = sb.exec("echo ok");
    expect(result.exitCode).toBe(0);
  });

  it("returns non-zero exitCode on failure", () => {
    sb = new Sandbox();
    const result = sb.exec("ls /nonexistent_dir_xyz");
    expect(result.exitCode).not.toBe(0);
  });

  it("blocks dangerous commands and returns exitCode 1", () => {
    sb = new Sandbox();
    const result = sb.exec("rm -rf /");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Blocked by sandbox");
  });

  it("uses an isolated workDir", () => {
    sb = new Sandbox();
    const result = sb.exec("pwd");
    expect(result.workDir).toContain("openmesh-sandbox-");
    expect(result.stdout).toContain("openmesh-sandbox-");
  });

  it("timeout returns timedOut=true", () => {
    sb = new Sandbox({ timeoutMs: 100 });
    const result = sb.exec("/bin/sleep 10");
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it("does not pass secrets to commands", () => {
    process.env.SUPER_SECRET_KEY = "leaked";
    sb = new Sandbox();
    const result = sb.exec("env");
    expect(result.stdout).not.toContain("SUPER_SECRET_KEY");
    expect(result.stdout).not.toContain("leaked");
    delete process.env.SUPER_SECRET_KEY;
  });

  it("uses custom workDir when specified", () => {
    const { mkdtempSync, realpathSync, rmSync: rmSyncFn } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const dir = mkdtempSync(join(tmpdir(), "sandbox-custom-"));
    const realDir = realpathSync(dir);
    sb = new Sandbox({ workDir: dir });
    const result = sb.exec("pwd");
    // macOS resolves /var → /private/var, so compare real paths
    expect(result.stdout).toBe(realDir);
    try {
      rmSyncFn(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });
});

// ── Execution (disabled) ────────────────────────────────────────────

describe("Sandbox.exec (disabled)", () => {
  it("runs directly when enabled=false", () => {
    const sb = new Sandbox({ enabled: false });
    const result = sb.exec("echo direct");
    expect(result.stdout).toBe("direct");
    expect(result.exitCode).toBe(0);
  });

  it("does NOT block dangerous commands when disabled", () => {
    const sb = new Sandbox({ enabled: false });
    // This won't actually delete anything because macOS protects /,
    // but the sandbox should not block it
    const result = sb.exec("echo 'rm -rf /'");
    // The command itself is just echoing, so it should succeed
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("rm -rf /");
  });
});

// ── Cleanup ─────────────────────────────────────────────────────────

describe("Sandbox.cleanup", () => {
  it("removes temp directories", () => {
    const sb = new Sandbox();
    const result = sb.exec("pwd");
    const dir = result.workDir;
    expect(existsSync(dir)).toBe(true);
    sb.cleanup();
    expect(existsSync(dir)).toBe(false);
  });

  it("handles missing dirs gracefully", () => {
    const sb = new Sandbox();
    sb.exec("pwd");
    sb.cleanup();
    // Second cleanup should not throw
    expect(() => sb.cleanup()).not.toThrow();
  });
});

// ── Config ──────────────────────────────────────────────────────────

describe("Sandbox config", () => {
  it("has correct default values", () => {
    const sb = new Sandbox();
    expect(sb.config.enabled).toBe(true);
    expect(sb.config.workDir).toBe("");
    expect(sb.config.timeoutMs).toBe(30_000);
    expect(sb.config.maxBuffer).toBe(1024 * 1024);
    expect(sb.config.envAllowlist).toContain("PATH");
    expect(sb.config.envAllowlist).toContain("HOME");
    expect(sb.config.envOverrides).toEqual({});
  });

  it("applies custom config", () => {
    const cfg: SandboxConfig = {
      enabled: false,
      workDir: "/tmp/custom",
      timeoutMs: 5000,
      maxBuffer: 512,
      envAllowlist: ["PATH"],
      envOverrides: { FOO: "bar" },
    };
    const sb = new Sandbox(cfg);
    expect(sb.config.enabled).toBe(false);
    expect(sb.config.workDir).toBe("/tmp/custom");
    expect(sb.config.timeoutMs).toBe(5000);
    expect(sb.config.maxBuffer).toBe(512);
    expect(sb.config.envAllowlist).toEqual(["PATH"]);
    expect(sb.config.envOverrides).toEqual({ FOO: "bar" });
  });

  it("default env allowlist includes PATH, HOME, USER, SHELL, TERM, LANG", () => {
    const sb = new Sandbox();
    for (const key of ["PATH", "HOME", "USER", "SHELL", "TERM", "LANG"]) {
      expect(sb.config.envAllowlist).toContain(key);
    }
  });
});

// ── Integration with Mesh ───────────────────────────────────────────

describe("Mesh sandbox integration", () => {
  it("Mesh has a sandbox field", () => {
    const mesh = new Mesh({ dataDir: "" });
    expect(mesh.sandbox).toBeInstanceOf(Sandbox);
  });

  it("Mesh sandbox uses config from MeshConfig", () => {
    const mesh = new Mesh({
      dataDir: "",
      sandbox: { timeoutMs: 5000, envAllowlist: ["PATH"] },
    });
    expect(mesh.sandbox.config.timeoutMs).toBe(5000);
    expect(mesh.sandbox.config.envAllowlist).toEqual(["PATH"]);
  });

  it("Mesh sandbox defaults are sane", () => {
    const mesh = new Mesh({ dataDir: "" });
    expect(mesh.sandbox.config.enabled).toBe(true);
    expect(mesh.sandbox.config.timeoutMs).toBe(30_000);
  });
});
