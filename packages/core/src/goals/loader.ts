/**
 * Goal loader — loads goals from YAML files.
 *
 * Supports:
 *   - Single YAML file
 *   - Directory of YAML files
 *   - Inline YAML string parsing
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import type { Goal, GoalStep } from "../coordinators/index.js";

/**
 * Minimal YAML parser — handles the subset of YAML used by goal definitions.
 * For production, consider using the `yaml` npm package.
 *
 * Supports: scalars, arrays (- item), objects (key: value), quoted strings,
 * and nested structures via indentation.
 */
export function parseSimpleYaml(input: string): Record<string, unknown> {
  const lines = input.split("\n");
  const result: Record<string, unknown> = {};
  const stack: Array<{ indent: number; obj: Record<string, unknown>; key?: string }> = [
    { indent: -1, obj: result },
  ];

  let currentArray: unknown[] | null = null;
  let currentArrayIndent = -1;

  for (const rawLine of lines) {
    // Skip comments and blank lines
    if (/^\s*#/.test(rawLine) || /^\s*$/.test(rawLine)) continue;

    const indent = rawLine.search(/\S/);
    const trimmed = rawLine.trim();

    // Array item
    if (trimmed.startsWith("- ")) {
      const itemContent = trimmed.slice(2).trim();

      if (currentArray && indent >= currentArrayIndent) {
        // Check if it's a key-value pair
        const kvMatch = /^(\w+):\s*(.+)$/.exec(itemContent);
        if (kvMatch) {
          const obj: Record<string, unknown> = {};
          obj[kvMatch[1]!] = parseValue(kvMatch[2]!);
          currentArray.push(obj);
          // Push onto stack so continuation keys are added to this object
          stack.push({ indent, obj });
        } else {
          currentArray.push(parseValue(itemContent));
        }
        continue;
      }
    }

    // Key-value pair
    const kvMatch = /^(\w+):\s*(.*)$/.exec(trimmed);
    if (kvMatch) {
      const [, key, value] = kvMatch;

      // Pop stack to correct level
      while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) {
        stack.pop();
      }
      const parent = stack[stack.length - 1]!.obj;

      if (value && value.trim()) {
        parent[key!] = parseValue(value.trim());
        // Only clear currentArray when we've left the array context
        if (!currentArray || indent < currentArrayIndent) {
          currentArray = null;
        }
      } else {
        // Start of nested object or array (value on next lines)
        const child: Record<string, unknown> = {};
        parent[key!] = child;
        stack.push({ indent, obj: child, key: key! });

        // Peek ahead: if next non-empty line starts with "- ", this is an array
        const nextI = lines.indexOf(rawLine) + 1;
        for (let j = nextI; j < lines.length; j++) {
          const nextLine = lines[j]!.trim();
          if (!nextLine || nextLine.startsWith("#")) continue;
          if (nextLine.startsWith("- ")) {
            const arr: unknown[] = [];
            parent[key!] = arr;
            currentArray = arr;
            currentArrayIndent = indent + 2;
            stack.pop(); // Remove the child object we just pushed
          }
          break;
        }
      }
    }
  }

  return result;
}

function parseValue(raw: string): unknown {
  // Remove quotes
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // Numbers
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  // Booleans
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  return raw;
}

/** Load a single goal from a YAML file */
export function loadGoalFromYaml(filePath: string): Goal {
  const content = readFileSync(filePath, "utf-8");
  const data = parseSimpleYaml(content) as Record<string, unknown>;

  return yamlToGoal(data);
}

/** Load all goals from a directory of YAML files */
export function loadGoalsFromDir(dirPath: string): Goal[] {
  if (!existsSync(dirPath)) return [];

  const files = readdirSync(dirPath).filter(
    (f) => extname(f) === ".yaml" || extname(f) === ".yml",
  );

  return files.map((f) => loadGoalFromYaml(join(dirPath, f)));
}

function yamlToGoal(data: Record<string, unknown>): Goal {
  return {
    id: data["id"] as string,
    description: (data["description"] as string) ?? "",
    observe: (data["observe"] as Array<Record<string, unknown>>).map((o) => ({
      type: o["type"] as string,
      where: o["where"] as Record<string, unknown> | undefined,
    })),
    then: (data["then"] as Array<Record<string, unknown>>).map(
      (step): GoalStep => ({
        label: step["label"] as string,
        operator: step["operator"] as string,
        task: step["task"] as string,
        when: step["when"] as string | undefined,
        timeoutMs: step["timeoutMs"] as number | undefined,
        channel: step["channel"] as string | undefined,
        to: step["to"] as string | undefined,
        retry: step["retry"]
          ? {
              maxRetries: (step["retry"] as Record<string, unknown>)["maxRetries"] as number,
              delayMs: (step["retry"] as Record<string, unknown>)["delayMs"] as number | undefined,
              backoffMultiplier: (step["retry"] as Record<string, unknown>)["backoffMultiplier"] as number | undefined,
              maxDelayMs: (step["retry"] as Record<string, unknown>)["maxDelayMs"] as number | undefined,
            }
          : undefined,
      }),
    ),
    escalate: data["escalate"]
      ? {
          afterFailures: (data["escalate"] as Record<string, unknown>)["afterFailures"] as number,
          channel: (data["escalate"] as Record<string, unknown>)["channel"] as string,
          to: (data["escalate"] as Record<string, unknown>)["to"] as string,
        }
      : undefined,
    dedupWindowMs: data["dedupWindowMs"] as number | undefined,
  };
}
