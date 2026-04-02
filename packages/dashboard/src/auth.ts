import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface AuthConfig {
  /** List of valid API keys. If empty/undefined, auth is disabled (all requests allowed). */
  apiKeys?: string[];
  /** Custom header name to check for the API key. Default: "x-mesh-api-key" */
  headerName?: string;
  /** Cookie name to check for the API key. Default: "mesh_api_key" */
  cookieName?: string;
  /** Explicitly enable/disable auth. When false, all requests are allowed. */
  enabled?: boolean;
}

/**
 * Timing-safe comparison of two strings.
 * Pads the shorter buffer so both are equal length before comparing,
 * preventing length-based timing leaks.
 */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) {
    // Compare against self to burn constant time, then return false
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Extract API key from the Authorization header (Bearer scheme). */
function extractBearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}

/** Extract API key from a custom header. */
function extractCustomHeader(req: IncomingMessage, headerName: string): string | undefined {
  const value = req.headers[headerName.toLowerCase()];
  if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

/** Extract API key from the `api_key` query parameter. */
function extractQueryParam(req: IncomingMessage): string | undefined {
  const url = req.url;
  if (!url) return undefined;
  const qIdx = url.indexOf("?");
  if (qIdx === -1) return undefined;
  const params = new URLSearchParams(url.slice(qIdx));
  return params.get("api_key") ?? undefined;
}

/** Extract API key from cookies. */
function extractCookie(req: IncomingMessage, cookieName: string): string | undefined {
  const header = req.headers["cookie"];
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.split("=");
    if (name?.trim() === cookieName) {
      return rest.join("=").trim() || undefined;
    }
  }
  return undefined;
}

/**
 * Validate an incoming request against the auth configuration.
 *
 * Checks for a valid API key in (order):
 *   1. Authorization: Bearer <key>
 *   2. Custom header (default: X-Mesh-Api-Key)
 *   3. Query parameter `?api_key=<key>`
 *   4. Cookie (default: mesh_api_key)
 *
 * Returns `true` if auth is disabled or the request contains a valid key.
 */
export function validateRequest(req: IncomingMessage, config: AuthConfig): boolean {
  // Backwards-compatible: if auth is explicitly disabled or no keys configured, allow everything
  if (config.enabled === false) return true;
  if (!config.apiKeys || config.apiKeys.length === 0) return true;

  const headerName = config.headerName ?? "x-mesh-api-key";
  const cookieName = config.cookieName ?? "mesh_api_key";

  const candidates = [
    extractBearerToken(req),
    extractCustomHeader(req, headerName),
    extractQueryParam(req),
    extractCookie(req, cookieName),
  ];

  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    for (const key of config.apiKeys) {
      if (safeCompare(candidate, key)) return true;
    }
  }

  return false;
}
