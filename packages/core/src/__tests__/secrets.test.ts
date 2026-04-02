import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EnvSecretBackend,
  FileSecretBackend,
  VaultSecretBackend,
  AwsSecretsBackend,
  OnePasswordBackend,
  SecretsManager,
} from "../secrets/index.js";

// ── EnvSecretBackend ────────────────────────────────────────────────

describe("EnvSecretBackend", () => {
  const backend = new EnvSecretBackend();
  const testKey = "OPENMESH_TEST_SECRET_XYZ";

  afterEach(() => {
    delete process.env[testKey];
  });

  it("returns undefined for missing keys", async () => {
    expect(await backend.get(testKey)).toBeUndefined();
  });

  it("sets and gets a value", async () => {
    await backend.set(testKey, "hello");
    expect(await backend.get(testKey)).toBe("hello");
    expect(process.env[testKey]).toBe("hello");
  });

  it("deletes a value", async () => {
    process.env[testKey] = "to-delete";
    await backend.delete(testKey);
    expect(process.env[testKey]).toBeUndefined();
    expect(await backend.get(testKey)).toBeUndefined();
  });

  it("lists all env keys", async () => {
    process.env[testKey] = "listed";
    const keys = await backend.list();
    expect(keys).toContain(testKey);
    expect(keys).toContain("PATH"); // sanity check
  });

  it("rejects invalid keys", async () => {
    await expect(backend.get("bad key!")).rejects.toThrow("Invalid secret key");
    await expect(backend.set("", "val")).rejects.toThrow("Invalid secret key");
  });
});

// ── FileSecretBackend ───────────────────────────────────────────────

describe("FileSecretBackend", () => {
  let tmpDir: string;
  let filePath: string;
  let backend: FileSecretBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "om-secrets-"));
    filePath = join(tmpDir, "secrets.json");
    backend = new FileSecretBackend(filePath);
  });

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("returns undefined when file does not exist", async () => {
    expect(await backend.get("missing")).toBeUndefined();
  });

  it("creates file on set and reads back", async () => {
    await backend.set("DB_PASS", "s3cret");
    expect(await backend.get("DB_PASS")).toBe("s3cret");
    // Verify file was created
    expect(existsSync(filePath)).toBe(true);
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw.DB_PASS).toBe("s3cret");
  });

  it("deletes a key and persists", async () => {
    await backend.set("A", "1");
    await backend.set("B", "2");
    await backend.delete("A");
    expect(await backend.get("A")).toBeUndefined();
    expect(await backend.get("B")).toBe("2");
  });

  it("lists keys from file", async () => {
    await backend.set("X", "1");
    await backend.set("Y", "2");
    const keys = await backend.list();
    expect(keys.sort()).toEqual(["X", "Y"]);
  });

  it("loads pre-existing JSON file", async () => {
    writeFileSync(filePath, JSON.stringify({ pre: "existing" }));
    const fresh = new FileSecretBackend(filePath);
    expect(await fresh.get("pre")).toBe("existing");
  });

  it("ignores non-string values in JSON", async () => {
    writeFileSync(filePath, JSON.stringify({ str: "ok", num: 42, obj: {} }));
    const fresh = new FileSecretBackend(filePath);
    expect(await fresh.get("str")).toBe("ok");
    expect(await fresh.get("num")).toBeUndefined();
  });

  it("creates nested directories", async () => {
    const nested = join(tmpDir, "a", "b", "secrets.json");
    const nestedBackend = new FileSecretBackend(nested);
    await nestedBackend.set("deep", "value");
    expect(await nestedBackend.get("deep")).toBe("value");
    expect(existsSync(nested)).toBe(true);
  });
});

// ── VaultSecretBackend (mocked fetch) ───────────────────────────────

describe("VaultSecretBackend", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockFetch(status: number, body: unknown) {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
  }

  const vault = new VaultSecretBackend({
    address: "https://vault.example.com",
    token: "test-token",
    path: "secret/data",
    namespace: "myns",
  });

  it("gets a secret", async () => {
    mockFetch(200, { data: { data: { value: "my-pass" } } });
    const val = await vault.get("db_password");
    expect(val).toBe("my-pass");

    const [url, opts] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://vault.example.com/v1/secret/data/db_password");
    expect((opts as RequestInit).method).toBe("GET");
    expect((opts as RequestInit).headers).toEqual(
      expect.objectContaining({ "X-Vault-Token": "test-token", "X-Vault-Namespace": "myns" }),
    );
  });

  it("returns undefined on 404", async () => {
    mockFetch(404, {});
    expect(await vault.get("nope")).toBeUndefined();
  });

  it("sets a secret via POST", async () => {
    mockFetch(200, {});
    await vault.set("key1", "val1");

    const [, opts] = fetchSpy.mock.calls[0]!;
    expect((opts as RequestInit).method).toBe("POST");
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({ data: { value: "val1" } });
  });

  it("deletes a secret", async () => {
    mockFetch(200, {});
    await vault.delete("key1");
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).method).toBe("DELETE");
  });

  it("lists secrets", async () => {
    mockFetch(200, { data: { keys: ["a", "b", "c"] } });
    const keys = await vault.list();
    expect(keys).toEqual(["a", "b", "c"]);
    expect(fetchSpy.mock.calls[0]![0]).toContain("?list=true");
  });

  it("throws on non-OK response", async () => {
    mockFetch(500, { errors: ["internal"] });
    await expect(vault.get("x")).rejects.toThrow("Vault GET failed (500)");
  });
});

// ── AwsSecretsBackend (mocked fetch) ────────────────────────────────

describe("AwsSecretsBackend", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const aws = new AwsSecretsBackend({ region: "us-west-2" });

  it("gets a secret", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ SecretString: "aws-val" }), { status: 200 }),
    );
    expect(await aws.get("my_key")).toBe("aws-val");

    const [url, opts] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://secretsmanager.us-west-2.amazonaws.com");
    expect((opts as RequestInit).headers).toEqual(
      expect.objectContaining({ "X-Amz-Target": "secretsmanager.GetSecretValue" }),
    );
  });

  it("returns undefined on ResourceNotFoundException", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ __type: "ResourceNotFoundException" }), { status: 400 }),
    );
    expect(await aws.get("missing")).toBeUndefined();
  });

  it("sets a secret (PutSecretValue)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await aws.set("k", "v");
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ SecretId: "k", SecretString: "v" });
  });

  it("creates secret on PutSecretValue ResourceNotFoundException", async () => {
    // First call: PutSecretValue fails with not found
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ __type: "ResourceNotFoundException" }), { status: 400 }),
    );
    // Second call: CreateSecret succeeds
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await aws.set("new_key", "new_val");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const headers2 = (fetchSpy.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(headers2["X-Amz-Target"]).toBe("secretsmanager.CreateSecret");
  });

  it("deletes a secret", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await aws.delete("k");
    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-Amz-Target"]).toBe("secretsmanager.DeleteSecret");
  });

  it("lists secrets", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ SecretList: [{ Name: "a" }, { Name: "b" }] }), { status: 200 }),
    );
    expect(await aws.list()).toEqual(["a", "b"]);
  });
});

// ── OnePasswordBackend (mocked execFile via vi.mock) ────────────────

const { execFileMock } = vi.hoisted(() => {
  const execFileMock = vi.fn();
  return { execFileMock };
});
vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

describe("OnePasswordBackend", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  function makeOp() {
    return new OnePasswordBackend({ vault: "TestVault" });
  }

  function mockExec(stdout: string) {
    execFileMock.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
        cb(null, stdout, "");
      },
    );
  }

  function mockExecError(msg: string) {
    execFileMock.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error, stdout: string, stderr: string) => void) => {
        cb(new Error(msg), "", msg);
      },
    );
  }

  it("gets a secret via op CLI", async () => {
    mockExec(JSON.stringify({ value: "1p-secret" }));
    const op = makeOp();
    expect(await op.get("api_key")).toBe("1p-secret");

    const [cmd, args, opts] = execFileMock.mock.calls[0]!;
    expect(cmd).toBe("op");
    expect(args).toContain("item");
    expect(args).toContain("get");
    expect(args).toContain("api_key");
    expect(args).toContain("--vault");
    expect(args).toContain("TestVault");
    expect(opts.shell).toBe(false);
  });

  it("returns undefined when op get fails", async () => {
    mockExecError("item not found");
    expect(await makeOp().get("nope")).toBeUndefined();
  });

  it("sets a secret (tries edit, falls back to create)", async () => {
    mockExecError("not found");
    mockExec("created");
    await makeOp().set("new_item", "new_val");
    expect(execFileMock).toHaveBeenCalledTimes(2);
    const createArgs = execFileMock.mock.calls[1]![1];
    expect(createArgs).toContain("create");
    expect(createArgs).toContain("--title");
    expect(createArgs).toContain("new_item");
  });

  it("deletes a secret", async () => {
    mockExec("");
    await makeOp().delete("del_key");
    const args = execFileMock.mock.calls[0]![1];
    expect(args).toContain("delete");
    expect(args).toContain("del_key");
  });

  it("lists secrets", async () => {
    mockExec(JSON.stringify([{ title: "itemA" }, { title: "itemB" }]));
    const keys = await makeOp().list();
    expect(keys).toEqual(["itemA", "itemB"]);
  });

  it("returns empty list on op error", async () => {
    mockExecError("unauthorized");
    expect(await makeOp().list()).toEqual([]);
  });
});

// ── SecretsManager ──────────────────────────────────────────────────

describe("SecretsManager", () => {
  const testKey = "OPENMESH_SM_TEST_KEY";

  afterEach(() => {
    delete process.env[testKey];
  });

  it("defaults to EnvSecretBackend", async () => {
    const sm = new SecretsManager();
    process.env[testKey] = "from-env";
    expect(await sm.get(testKey)).toBe("from-env");
  });

  it("chains backends with fallthrough", async () => {
    const sm = new SecretsManager();
    const stub: SecretBackend = {
      id: "stub",
      get: async (k) => (k === "ONLY_IN_STUB" ? "stub-val" : undefined),
      set: async () => {},
      delete: async () => {},
      list: async () => ["ONLY_IN_STUB"],
    };
    // Remove env and add stub first, then env
    sm.removeBackend("env");
    sm.addBackend(stub);
    sm.addBackend(new EnvSecretBackend());

    process.env[testKey] = "env-val";

    // Falls through stub → env for testKey
    expect(await sm.get(testKey)).toBe("env-val");
    // Found in stub
    expect(await sm.get("ONLY_IN_STUB")).toBe("stub-val");
  });

  it("writes to primary (first) backend", async () => {
    const sm = new SecretsManager();
    await sm.set(testKey, "written");
    expect(process.env[testKey]).toBe("written");
  });

  it("merges and deduplicates list across backends", async () => {
    const sm = new SecretsManager();
    const stub: SecretBackend = {
      id: "stub",
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      list: async () => ["A", "B"],
    };
    sm.addBackend(stub);

    process.env.A = "1";
    const keys = await sm.list();
    // Both backends have "A", should appear once
    const filtered = keys.filter((k) => k === "A");
    expect(filtered).toHaveLength(1);
    expect(keys).toContain("B");
  });

  it("throws on duplicate backend id", () => {
    const sm = new SecretsManager();
    expect(() => sm.addBackend(new EnvSecretBackend())).toThrow("already registered");
  });

  it("throws removing unknown backend", () => {
    const sm = new SecretsManager();
    expect(() => sm.removeBackend("nope")).toThrow("not found");
  });

  it("uses primaryBackend config for writes", async () => {
    let tmpDir: string | undefined;
    try {
      tmpDir = mkdtempSync(join(tmpdir(), "om-sm-"));
      const filePath = join(tmpDir, "s.json");
      const sm = new SecretsManager({
        backends: [
          { type: "env" },
          { type: "file", config: { filePath } },
        ],
        primaryBackend: "file",
      });
      await sm.set("FILE_KEY", "file-val");
      // Should NOT be in env
      expect(process.env.FILE_KEY).toBeUndefined();
      // Should be in file
      expect(await sm.get("FILE_KEY")).toBe("file-val");
    } finally {
      if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    }
  });

  it("creates manager from config with multiple backends", () => {
    // Should not throw
    const sm = new SecretsManager({
      backends: [{ type: "env" }],
    });
    expect(sm).toBeInstanceOf(SecretsManager);
  });

  it("throws on unknown backend type", () => {
    expect(() => new SecretsManager({
      backends: [{ type: "bogus" as "env" }],
    })).toThrow("Unknown secret backend type");
  });
});

// ── resolveConfig ───────────────────────────────────────────────────

describe("SecretsManager.resolveConfig", () => {
  const testEnvA = "OPENMESH_RC_A";
  const testEnvB = "OPENMESH_RC_B";

  afterEach(() => {
    delete process.env[testEnvA];
    delete process.env[testEnvB];
  });

  it("replaces ${SECRET:key} patterns in strings", async () => {
    process.env[testEnvA] = "resolved-a";
    const sm = new SecretsManager();
    const result = await sm.resolveConfig({
      url: "https://host.com",
      token: "${SECRET:OPENMESH_RC_A}",
    });
    expect(result.url).toBe("https://host.com");
    expect(result.token).toBe("resolved-a");
  });

  it("handles multiple replacements in one string", async () => {
    process.env[testEnvA] = "user";
    process.env[testEnvB] = "pass";
    const sm = new SecretsManager();
    const result = await sm.resolveConfig({
      dsn: "postgres://${SECRET:OPENMESH_RC_A}:${SECRET:OPENMESH_RC_B}@localhost/db",
    });
    expect(result.dsn).toBe("postgres://user:pass@localhost/db");
  });

  it("leaves unresolvable patterns as-is", async () => {
    const sm = new SecretsManager();
    const result = await sm.resolveConfig({ val: "${SECRET:DOES_NOT_EXIST_XYZ}" });
    expect(result.val).toBe("${SECRET:DOES_NOT_EXIST_XYZ}");
  });

  it("resolves nested objects and arrays", async () => {
    process.env[testEnvA] = "deep";
    const sm = new SecretsManager();
    const result = await sm.resolveConfig({
      nested: { key: "${SECRET:OPENMESH_RC_A}" },
      list: ["${SECRET:OPENMESH_RC_A}", "literal"],
      count: 42,
      flag: true,
    });
    expect(result.nested).toEqual({ key: "deep" });
    expect(result.list).toEqual(["deep", "literal"]);
    expect(result.count).toBe(42);
    expect(result.flag).toBe(true);
  });
});

// ── Mesh integration ────────────────────────────────────────────────

describe("Mesh.secrets integration", () => {
  it("exposes SecretsManager on mesh instance", async () => {
    const { Mesh } = await import("../runtime/mesh.js");
    const mesh = new Mesh();
    expect(mesh.secrets).toBeInstanceOf(SecretsManager);
  });

  it("passes secrets config to SecretsManager", async () => {
    const { Mesh } = await import("../runtime/mesh.js");
    const mesh = new Mesh({
      secrets: { backends: [{ type: "env" }] },
    });
    process.env.MESH_SEC_TEST = "integrated";
    expect(await mesh.secrets.get("MESH_SEC_TEST")).toBe("integrated");
    delete process.env.MESH_SEC_TEST;
  });
});

// Re-import for type usage
import type { SecretBackend } from "../secrets/index.js";
