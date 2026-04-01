/**
 * Structured logging via Pino — the fastest Node.js logger.
 *
 * Replaces console.log throughout the mesh with structured JSON logs
 * that can be shipped to any log aggregator.
 */

import pino from "pino";
import type { MeshLogger } from "@openmesh/core";

export type MeshPinoLogger = pino.Logger;

export function createLogger(options?: {
  level?: string;
  name?: string;
  pretty?: boolean;
}): MeshPinoLogger {
  return pino({
    name: options?.name ?? "openmesh",
    level: options?.level ?? process.env["OPENMESH_LOG_LEVEL"] ?? "info",
    ...(options?.pretty
      ? { transport: { target: "pino-pretty", options: { colorize: true } } }
      : {}),
  });
}

/**
 * Create a MeshLogger function compatible with Mesh constructor.
 * Bridges Pino into the existing MeshLogger interface.
 */
export function pinoToMeshLogger(logger: MeshPinoLogger): MeshLogger {
  return (level: string, component: string, message: string, ...args: unknown[]) => {
    const child = logger.child({ component });
    const logLevel = level as pino.Level;
    if (child[logLevel]) {
      child[logLevel](args.length ? { extra: args } : {}, message);
    } else {
      child.info(args.length ? { extra: args } : {}, `[${level}] ${message}`);
    }
  };
}
