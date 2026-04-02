/**
 * @openmesh/core/secrets — pluggable secrets management with backend chaining.
 *
 * Provides a unified interface for retrieving secrets from multiple backends
 * (env vars, files, Vault, AWS Secrets Manager, 1Password) with fallthrough logic.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile } from "node:child_process";

// ── Public Interfaces ───────────────────────────────────────────────

export interface SecretBackend {
  readonly id: string;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface SecretsManagerConfig {
  backends?: Array<{
    type: "env" | "file" | "vault" | "aws" | "1password";
    config?: Record<string, unknown>;
  }>;
  /** ID of the backend used for writes (defaults to first backend). */
  primaryBackend?: string;
}

// ── Key validation ──────────────────────────────────────────────────

const VALID_KEY = /^[A-Za-z0-9_.\-/]{1,256}$/;

function assertValidKey(key: string): void {
  if (!VALID_KEY.test(key)) {
    throw new Error(
      `Invalid secret key "${key}": must match ${VALID_KEY} (1-256 chars, alphanumeric/underscore/dash/dot/slash)`,
    );
  }
}

// ── EnvSecretBackend ────────────────────────────────────────────────

export class EnvSecretBackend implements SecretBackend {
  readonly id = "env";

  async get(key: string): Promise<string | undefined> {
    assertValidKey(key);
    return process.env[key];
  }

  async set(key: string, value: string): Promise<void> {
    assertValidKey(key);
    process.env[key] = value;
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    delete process.env[key];
  }

  async list(): Promise<string[]> {
    return Object.keys(process.env);
  }
}

// ── FileSecretBackend ───────────────────────────────────────────────

export class FileSecretBackend implements SecretBackend {
  readonly id = "file";
  private cache: Record<string, string> | null = null;

  constructor(private readonly filePath: string) {}

  async get(key: string): Promise<string | undefined> {
    assertValidKey(key);
    const data = await this.load();
    return data[key];
  }

  async set(key: string, value: string): Promise<void> {
    assertValidKey(key);
    const data = await this.load();
    data[key] = value;
    await this.flush(data);
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    const data = await this.load();
    delete data[key];
    await this.flush(data);
  }

  async list(): Promise<string[]> {
    const data = await this.load();
    return Object.keys(data);
  }

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Secrets file must contain a JSON object");
      }
      // Only keep string values
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") result[k] = v;
      }
      this.cache = result;
      return result;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = {};
        return this.cache;
      }
      throw err;
    }
  }

  private async flush(data: Record<string, string>): Promise<void> {
    this.cache = data;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2), "utf-8");
  }
}

// ── VaultSecretBackend ──────────────────────────────────────────────

export interface VaultConfig {
  address: string;
  token?: string;
  path?: string;
  namespace?: string;
}

export class VaultSecretBackend implements SecretBackend {
  readonly id = "vault";
  private readonly address: string;
  private readonly token: string;
  private readonly path: string;
  private readonly namespace?: string;

  constructor(config: VaultConfig) {
    this.address = config.address.replace(/\/+$/, "");
    this.token = config.token ?? process.env.VAULT_TOKEN ?? "";
    this.path = config.path ?? "secret/data";
    this.namespace = config.namespace ?? process.env.VAULT_NAMESPACE;
  }

  async get(key: string): Promise<string | undefined> {
    assertValidKey(key);
    const res = await fetch(`${this.address}/v1/${this.path}/${encodeURIComponent(key)}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`Vault GET failed (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as { data?: { data?: { value?: string } } };
    return body.data?.data?.value;
  }

  async set(key: string, value: string): Promise<void> {
    assertValidKey(key);
    const res = await fetch(`${this.address}/v1/${this.path}/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ data: { value } }),
    });
    if (!res.ok) throw new Error(`Vault POST failed (${res.status}): ${await res.text()}`);
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    const res = await fetch(`${this.address}/v1/${this.path}/${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Vault DELETE failed (${res.status}): ${await res.text()}`);
    }
  }

  async list(): Promise<string[]> {
    const res = await fetch(`${this.address}/v1/${this.path}?list=true`, {
      method: "GET",
      headers: this.headers(),
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`Vault LIST failed (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as { data?: { keys?: string[] } };
    return body.data?.keys ?? [];
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "X-Vault-Token": this.token };
    if (this.namespace) h["X-Vault-Namespace"] = this.namespace;
    return h;
  }
}

// ── AwsSecretsBackend ───────────────────────────────────────────────

export interface AwsSecretsConfig {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export class AwsSecretsBackend implements SecretBackend {
  readonly id = "aws";
  private readonly region: string;
  private readonly endpoint: string;

  constructor(config?: AwsSecretsConfig) {
    this.region = config?.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
    this.endpoint = `https://secretsmanager.${this.region}.amazonaws.com`;

    // Inject credentials into env if explicitly provided so the
    // standard AWS credential chain picks them up from node.
    if (config?.accessKeyId) process.env.AWS_ACCESS_KEY_ID = config.accessKeyId;
    if (config?.secretAccessKey) process.env.AWS_SECRET_ACCESS_KEY = config.secretAccessKey;
  }

  async get(key: string): Promise<string | undefined> {
    assertValidKey(key);
    try {
      const body = await this.call("secretsmanager.GetSecretValue", { SecretId: key });
      return (body as { SecretString?: string }).SecretString;
    } catch (err: unknown) {
      if (err instanceof AwsApiError && err.awsCode === "ResourceNotFoundException") return undefined;
      throw err;
    }
  }

  async set(key: string, value: string): Promise<void> {
    assertValidKey(key);
    try {
      // Try to update first
      await this.call("secretsmanager.PutSecretValue", { SecretId: key, SecretString: value });
    } catch (err: unknown) {
      if (err instanceof AwsApiError && err.awsCode === "ResourceNotFoundException") {
        // Create the secret if it doesn't exist
        await this.call("secretsmanager.CreateSecret", { Name: key, SecretString: value });
        return;
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    try {
      await this.call("secretsmanager.DeleteSecret", {
        SecretId: key,
        ForceDeleteWithoutRecovery: true,
      });
    } catch (err: unknown) {
      if (err instanceof AwsApiError && err.awsCode === "ResourceNotFoundException") return;
      throw err;
    }
  }

  async list(): Promise<string[]> {
    const body = await this.call("secretsmanager.ListSecrets", {});
    const list = (body as { SecretList?: Array<{ Name?: string }> }).SecretList ?? [];
    return list.map((s) => s.Name).filter((n): n is string => typeof n === "string");
  }

  private async call(target: string, payload: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": target,
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) {
      let awsCode = "Unknown";
      try {
        const parsed = JSON.parse(text) as { __type?: string };
        awsCode = parsed.__type?.split("#").pop() ?? "Unknown";
      } catch { /* ignore */ }
      throw new AwsApiError(`AWS SecretsManager ${target} failed (${res.status}): ${text}`, awsCode);
    }
    return JSON.parse(text) as unknown;
  }
}

class AwsApiError extends Error {
  constructor(message: string, readonly awsCode: string) {
    super(message);
    this.name = "AwsApiError";
  }
}

// ── OnePasswordBackend ──────────────────────────────────────────────

export interface OnePasswordConfig {
  vault?: string;
  serviceAccountToken?: string;
}

/** Promisified execFile wrapper with strict argument passing (no shell). */
function execOp(args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("op", args, { shell: false, env: { ...process.env, ...env }, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`op ${args[0]} failed: ${stderr || err.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export class OnePasswordBackend implements SecretBackend {
  readonly id = "1password";
  private readonly vault: string;
  private readonly extraEnv: Record<string, string>;

  constructor(config?: OnePasswordConfig) {
    this.vault = config?.vault ?? "Private";
    this.extraEnv = {};
    const token = config?.serviceAccountToken ?? process.env.OP_SERVICE_ACCOUNT_TOKEN;
    if (token) this.extraEnv.OP_SERVICE_ACCOUNT_TOKEN = token;
  }

  async get(key: string): Promise<string | undefined> {
    assertValidKey(key);
    try {
      return await execOp(
        ["item", "get", key, "--vault", this.vault, "--fields", "password", "--format", "json"],
        this.extraEnv,
      ).then((raw) => {
        const parsed = JSON.parse(raw) as { value?: string };
        return parsed.value;
      });
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: string): Promise<void> {
    assertValidKey(key);
    try {
      // Try edit first (update existing)
      await execOp(
        ["item", "edit", key, "--vault", this.vault, `password=${value}`],
        this.extraEnv,
      );
    } catch {
      // Create if doesn't exist
      await execOp(
        ["item", "create", "--category", "password", "--title", key, "--vault", this.vault, `password=${value}`],
        this.extraEnv,
      );
    }
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    try {
      await execOp(["item", "delete", key, "--vault", this.vault], this.extraEnv);
    } catch {
      // Ignore — item may not exist
    }
  }

  async list(): Promise<string[]> {
    try {
      const raw = await execOp(
        ["item", "list", "--vault", this.vault, "--format", "json"],
        this.extraEnv,
      );
      const items = JSON.parse(raw) as Array<{ title?: string }>;
      return items.map((i) => i.title).filter((t): t is string => typeof t === "string");
    } catch {
      return [];
    }
  }
}

// ── SecretsManager ──────────────────────────────────────────────────

export class SecretsManager {
  private backends: SecretBackend[] = [];
  private primaryId?: string;

  constructor(config?: SecretsManagerConfig) {
    if (config?.primaryBackend) this.primaryId = config.primaryBackend;

    if (config?.backends) {
      for (const def of config.backends) {
        this.addBackend(createBackend(def.type, def.config));
      }
    }

    // Always ensure at least the env backend is available
    if (this.backends.length === 0) {
      this.addBackend(new EnvSecretBackend());
    }
  }

  addBackend(backend: SecretBackend): void {
    if (this.backends.some((b) => b.id === backend.id)) {
      throw new Error(`Backend with id "${backend.id}" already registered`);
    }
    this.backends.push(backend);
  }

  removeBackend(id: string): void {
    const idx = this.backends.findIndex((b) => b.id === id);
    if (idx === -1) throw new Error(`Backend "${id}" not found`);
    this.backends.splice(idx, 1);
  }

  /** Get from the first backend that has the key (fallthrough chain). */
  async get(key: string): Promise<string | undefined> {
    for (const backend of this.backends) {
      const value = await backend.get(key);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  /** Set on the primary backend (first, or the one matching primaryBackend id). */
  async set(key: string, value: string): Promise<void> {
    const primary = this.primary();
    await primary.set(key, value);
  }

  /** Delete from the primary backend. */
  async delete(key: string): Promise<void> {
    const primary = this.primary();
    await primary.delete(key);
  }

  /** List keys from all backends, merged and deduplicated. */
  async list(): Promise<string[]> {
    const seen = new Set<string>();
    for (const backend of this.backends) {
      for (const key of await backend.list()) {
        seen.add(key);
      }
    }
    return [...seen].sort();
  }

  /**
   * Resolve a config object by replacing `${SECRET:key}` patterns with
   * actual secret values. Processes string values recursively.
   */
  async resolveConfig<T extends Record<string, unknown>>(config: T): Promise<T> {
    return this.resolveValue(config) as Promise<T>;
  }

  private async resolveValue(value: unknown): Promise<unknown> {
    if (typeof value === "string") {
      return this.resolveString(value);
    }
    if (Array.isArray(value)) {
      return Promise.all(value.map((v) => this.resolveValue(v)));
    }
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = await this.resolveValue(v);
      }
      return result;
    }
    return value;
  }

  private async resolveString(str: string): Promise<string> {
    const pattern = /\$\{SECRET:([^}]+)\}/g;
    let match: RegExpExecArray | null;
    let result = str;

    // Collect all matches first, then resolve (avoid regex state issues)
    const replacements: Array<{ full: string; key: string }> = [];
    while ((match = pattern.exec(str)) !== null) {
      replacements.push({ full: match[0], key: match[1]! });
    }

    for (const { full, key } of replacements) {
      const secret = await this.get(key);
      if (secret !== undefined) {
        result = result.replace(full, secret);
      }
    }
    return result;
  }

  private primary(): SecretBackend {
    if (this.primaryId) {
      const found = this.backends.find((b) => b.id === this.primaryId);
      if (found) return found;
    }
    if (this.backends.length === 0) {
      throw new Error("No secret backends configured");
    }
    return this.backends[0]!;
  }
}

// ── Factory ─────────────────────────────────────────────────────────

function createBackend(type: string, config?: Record<string, unknown>): SecretBackend {
  switch (type) {
    case "env":
      return new EnvSecretBackend();
    case "file":
      return new FileSecretBackend((config?.filePath as string) ?? ".openmesh/secrets.json");
    case "vault":
      return new VaultSecretBackend(config as unknown as VaultConfig);
    case "aws":
      return new AwsSecretsBackend(config as unknown as AwsSecretsConfig);
    case "1password":
      return new OnePasswordBackend(config as unknown as OnePasswordConfig);
    default:
      throw new Error(`Unknown secret backend type: "${type}"`);
  }
}
