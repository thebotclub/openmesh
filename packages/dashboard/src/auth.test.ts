import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";
import { validateRequest, type AuthConfig } from "./auth.js";

/** Helper to create a minimal mock IncomingMessage. */
function mockReq(opts: {
  url?: string;
  headers?: Record<string, string | undefined>;
} = {}): IncomingMessage {
  return {
    url: opts.url ?? "/",
    headers: opts.headers ?? {},
  } as unknown as IncomingMessage;
}

describe("validateRequest", () => {
  // --- Backwards compatibility / disabled auth ---

  it("returns true when apiKeys is undefined (auth disabled)", () => {
    const req = mockReq();
    expect(validateRequest(req, {})).toBe(true);
  });

  it("returns true when apiKeys is an empty array", () => {
    const req = mockReq();
    expect(validateRequest(req, { apiKeys: [] })).toBe(true);
  });

  it("returns true when enabled is explicitly false", () => {
    const req = mockReq();
    expect(validateRequest(req, { apiKeys: ["secret"], enabled: false })).toBe(true);
  });

  // --- Bearer token ---

  it("returns true with a valid Bearer token", () => {
    const req = mockReq({ headers: { authorization: "Bearer my-secret-key" } });
    expect(validateRequest(req, { apiKeys: ["my-secret-key"] })).toBe(true);
  });

  it("returns false with an invalid Bearer token", () => {
    const req = mockReq({ headers: { authorization: "Bearer wrong-key" } });
    expect(validateRequest(req, { apiKeys: ["my-secret-key"] })).toBe(false);
  });

  it("is case-insensitive for the Bearer scheme", () => {
    const req = mockReq({ headers: { authorization: "bearer my-secret-key" } });
    expect(validateRequest(req, { apiKeys: ["my-secret-key"] })).toBe(true);
  });

  // --- Custom header ---

  it("returns true with a valid X-Mesh-Api-Key header", () => {
    const req = mockReq({ headers: { "x-mesh-api-key": "key123" } });
    expect(validateRequest(req, { apiKeys: ["key123"] })).toBe(true);
  });

  it("returns true with a valid custom header name", () => {
    const req = mockReq({ headers: { "x-custom-auth": "key456" } });
    expect(validateRequest(req, { apiKeys: ["key456"], headerName: "X-Custom-Auth" })).toBe(true);
  });

  it("returns false with an invalid custom header value", () => {
    const req = mockReq({ headers: { "x-mesh-api-key": "bad" } });
    expect(validateRequest(req, { apiKeys: ["good"] })).toBe(false);
  });

  // --- Query parameter ---

  it("returns true with a valid api_key query parameter", () => {
    const req = mockReq({ url: "/api/state?api_key=qp-secret" });
    expect(validateRequest(req, { apiKeys: ["qp-secret"] })).toBe(true);
  });

  it("returns false with an invalid api_key query parameter", () => {
    const req = mockReq({ url: "/api/state?api_key=wrong" });
    expect(validateRequest(req, { apiKeys: ["correct"] })).toBe(false);
  });

  // --- Cookie ---

  it("returns true with a valid cookie", () => {
    const req = mockReq({ headers: { cookie: "mesh_api_key=cookie-secret" } });
    expect(validateRequest(req, { apiKeys: ["cookie-secret"] })).toBe(true);
  });

  it("returns true with a valid custom cookie name", () => {
    const req = mockReq({ headers: { cookie: "my_auth=custom-secret" } });
    expect(validateRequest(req, { apiKeys: ["custom-secret"], cookieName: "my_auth" })).toBe(true);
  });

  it("returns false when cookie value is wrong", () => {
    const req = mockReq({ headers: { cookie: "mesh_api_key=wrong" } });
    expect(validateRequest(req, { apiKeys: ["right"] })).toBe(false);
  });

  // --- Multiple keys ---

  it("accepts any key from the apiKeys list", () => {
    const config: AuthConfig = { apiKeys: ["key-a", "key-b", "key-c"] };
    expect(validateRequest(mockReq({ headers: { authorization: "Bearer key-b" } }), config)).toBe(true);
    expect(validateRequest(mockReq({ headers: { authorization: "Bearer key-c" } }), config)).toBe(true);
    expect(validateRequest(mockReq({ headers: { authorization: "Bearer key-x" } }), config)).toBe(false);
  });

  // --- No credentials at all ---

  it("returns false when auth is enabled but no credentials provided", () => {
    expect(validateRequest(mockReq(), { apiKeys: ["secret"] })).toBe(false);
  });

  // --- Timing-safe comparison ---

  it("correctly validates equal-length keys via timing-safe path", () => {
    // Same length, correct key — must pass
    const req = mockReq({ headers: { authorization: "Bearer test-key" } });
    expect(validateRequest(req, { apiKeys: ["test-key"] })).toBe(true);

    // Same length, wrong key — must fail
    const req2 = mockReq({ headers: { authorization: "Bearer teST-Key" } });
    expect(validateRequest(req2, { apiKeys: ["test-key"] })).toBe(false);
  });

  it("handles keys of different lengths safely (returns false)", () => {
    const req = mockReq({ headers: { authorization: "Bearer short" } });
    const result = validateRequest(req, { apiKeys: ["a-much-longer-key-value"] });
    expect(result).toBe(false);
  });

  it("rejects a key that is a prefix of a valid key", () => {
    const req = mockReq({ headers: { authorization: "Bearer abc" } });
    expect(validateRequest(req, { apiKeys: ["abcdef"] })).toBe(false);
  });

  // --- Edge cases ---

  it("ignores empty Authorization header", () => {
    const req = mockReq({ headers: { authorization: "" } });
    expect(validateRequest(req, { apiKeys: ["key"] })).toBe(false);
  });

  it("handles cookie string with multiple cookies", () => {
    const req = mockReq({ headers: { cookie: "foo=bar; mesh_api_key=valid-key; baz=qux" } });
    expect(validateRequest(req, { apiKeys: ["valid-key"] })).toBe(true);
  });
});
