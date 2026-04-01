#!/usr/bin/env node

import { Command } from "commander";
import {
  Mesh,
  loadGoalsFromDir,
  type Observer,
  type Operator,
} from "@openmesh/core";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const program = new Command();

program
  .name("mesh")
  .description("OpenMesh — AI-native operations platform")
  .version("0.1.0");

// ── mesh init ───────────────────────────────────────────────────────

program
  .command("init")
  .description("Initialize OpenMesh project in current directory")
  .action(() => {
    const goalsDir = resolve("goals");
    const dataDir = resolve(".openmesh");
    const configPath = resolve("mesh.config.json");

    if (!existsSync(goalsDir)) mkdirSync(goalsDir, { recursive: true });
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

    if (!existsSync(configPath)) {
      writeFileSync(configPath, JSON.stringify({
        dataDir: ".openmesh",
        goalsDir: "goals",
        observers: ["cron"],
        operators: ["code", "comms", "infra", "data"],
        logLevel: "info",
      }, null, 2) + "\n");
    }

    // Create example goal
    const exampleGoal = join(goalsDir, "example-heartbeat.yaml");
    if (!existsSync(exampleGoal)) {
      writeFileSync(exampleGoal, `# Example: log every cron tick
id: heartbeat
description: Log a heartbeat message on every cron tick

observe:
  - type: "cron.tick"

then:
  - label: log-heartbeat
    operator: comms
    task: "Heartbeat at {{event.timestamp}} — mesh is alive"
`);
    }

    console.log("✅ OpenMesh initialized:");
    console.log(`   Config: ${configPath}`);
    console.log(`   Goals:  ${goalsDir}/`);
    console.log(`   Data:   ${dataDir}/`);
    console.log("");
    console.log('Run "mesh run" to start.');
  });

// ── mesh run ────────────────────────────────────────────────────────

program
  .command("run")
  .description("Start the mesh runtime")
  .option("-g, --goals <dir>", "Goals directory", "goals")
  .option("-d, --data <dir>", "Data directory", ".openmesh")
  .option("--log-level <level>", "Log level", "info")
  .option("--dashboard", "Start web dashboard", false)
  .option("--dashboard-port <port>", "Dashboard port", "3777")
  .action(async (opts: { goals: string; data: string; logLevel: string; dashboard: boolean; dashboardPort: string }) => {
    const mesh = new Mesh({
      dataDir: resolve(opts.data),
      logLevel: opts.logLevel as "debug" | "info" | "warn" | "error",
    });

    // Load bundled observers
    const observerModules = await loadBundledObservers();
    for (const obs of observerModules) {
      mesh.addObserver(obs);
    }

    // Load bundled operators
    const operatorModules = await loadBundledOperators();
    for (const op of operatorModules) {
      mesh.addOperator(op);
    }

    // Load goals from YAML directory
    const goalsDir = resolve(opts.goals);
    if (existsSync(goalsDir)) {
      const goals = loadGoalsFromDir(goalsDir);
      for (const goal of goals) {
        mesh.addGoal(goal);
      }
      console.log(`Loaded ${goals.length} goal(s) from ${goalsDir}`);
    } else {
      console.log(`No goals directory found at ${goalsDir}. Run "mesh init" first.`);
    }

    // Start dashboard if requested
    let dashboardHandle: { close: () => void } | undefined;
    if (opts.dashboard) {
      try {
        const { startDashboard } = await import("@openmesh/dashboard");
        dashboardHandle = startDashboard({
          port: Number(opts.dashboardPort),
          dataDir: resolve(opts.data),
          goalsDir,
        });
      } catch {
        console.log("Dashboard not available (install @openmesh/dashboard)");
      }
    }

    // Graceful shutdown on SIGINT/SIGTERM
    const shutdown = async () => {
      dashboardHandle?.close();
      await mesh.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => { shutdown().catch(console.error); });
    process.on("SIGTERM", () => { shutdown().catch(console.error); });

    await mesh.start();
  });

// ── mesh inject ─────────────────────────────────────────────────────

program
  .command("inject <type>")
  .description("Inject a test event into the mesh")
  .option("-p, --payload <json>", "Event payload as JSON", "{}")
  .option("-s, --source <source>", "Event source", "manual")
  .option("-g, --goals <dir>", "Goals directory", "goals")
  .option("-d, --data <dir>", "Data directory", ".openmesh")
  .action(async (type: string, opts: { payload: string; source: string; goals: string; data: string }) => {
    const mesh = new Mesh({ dataDir: resolve(opts.data) });

    // Load operators so injected events can trigger goal steps
    const operatorModules = await loadBundledOperators();
    for (const op of operatorModules) {
      mesh.addOperator(op);
    }

    // Load goals
    const goalsDir = resolve(opts.goals);
    if (existsSync(goalsDir)) {
      const goals = loadGoalsFromDir(goalsDir);
      for (const goal of goals) {
        mesh.addGoal(goal);
      }
    }

    await mesh.start();

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(opts.payload) as Record<string, unknown>;
    } catch {
      console.error("Invalid JSON payload");
      process.exit(1);
    }

    const event = mesh.createEvent(type, opts.source, payload);
    console.log(`Injecting event: ${type} from ${opts.source}`);
    await mesh.inject(event);

    // Give operators a moment to complete
    await new Promise((r) => setTimeout(r, 500));
    await mesh.stop();
  });

// ── mesh status ─────────────────────────────────────────────────────

program
  .command("status")
  .description("Show mesh status: goals, recent events, pending approvals")
  .option("-d, --data <dir>", "Data directory", ".openmesh")
  .option("-g, --goals <dir>", "Goals directory", "goals")
  .action((opts: { data: string; goals: string }) => {
    const goalsDir = resolve(opts.goals);
    const dataDir = resolve(opts.data);
    const walPath = join(dataDir, "events.wal.jsonl");

    console.log("OpenMesh Status");
    console.log("================");

    // Goals
    if (existsSync(goalsDir)) {
      const goals = loadGoalsFromDir(goalsDir);
      console.log(`\nGoals (${goals.length}):`);
      for (const g of goals) {
        const observeStr = g.observe.map(o => o.type).join(", ");
        console.log(`  • ${g.id}: ${g.description}`);
        console.log(`    observes: ${observeStr}`);
        console.log(`    steps: ${g.then.map(s => s.label).join(" → ")}`);
      }
    } else {
      console.log("\nNo goals directory found.");
    }

    // WAL events
    if (existsSync(walPath)) {
      const content = readFileSync(walPath, "utf-8").trim();
      const events = content ? content.split("\n") : [];
      console.log(`\nEvent log: ${events.length} events`);
      // Show last 5
      const recent = events.slice(-5);
      for (const line of recent) {
        try {
          const evt = JSON.parse(line) as { type: string; timestamp: string; source: string };
          console.log(`  ${evt.timestamp} [${evt.source}] ${evt.type}`);
        } catch { /* skip malformed */ }
      }
      if (events.length > 5) {
        console.log(`  ... and ${events.length - 5} more`);
      }
    } else {
      console.log("\nNo event log found. Run \"mesh run\" to start collecting events.");
    }
  });

// ── mesh logs ───────────────────────────────────────────────────────

program
  .command("logs")
  .description("Stream the event log")
  .option("-d, --data <dir>", "Data directory", ".openmesh")
  .option("-n, --lines <count>", "Number of recent lines", "20")
  .option("-t, --type <pattern>", "Filter by event type pattern")
  .action((opts: { data: string; lines: string; type?: string }) => {
    const walPath = join(resolve(opts.data), "events.wal.jsonl");
    if (!existsSync(walPath)) {
      console.log("No event log found.");
      return;
    }

    const content = readFileSync(walPath, "utf-8").trim();
    if (!content) {
      console.log("Event log is empty.");
      return;
    }

    let lines = content.split("\n");
    const maxLines = Number(opts.lines);

    if (opts.type) {
      lines = lines.filter(line => {
        try {
          const evt = JSON.parse(line) as { type: string };
          return evt.type.includes(opts.type!);
        } catch { return false; }
      });
    }

    lines = lines.slice(-maxLines);
    for (const line of lines) {
      try {
        const evt = JSON.parse(line) as { type: string; timestamp: string; source: string; payload: unknown };
        console.log(`${evt.timestamp} [${evt.source}] ${evt.type} ${JSON.stringify(evt.payload)}`);
      } catch {
        console.log(line);
      }
    }
  });

program.parse();

// ── Helpers: load bundled observers/operators ───────────────────────

async function loadBundledObservers(): Promise<Observer[]> {
  const observers: Observer[] = [];
  const mods = [
    "@openmesh/observer-cron",
    "@openmesh/observer-log-stream",
    "@openmesh/observer-http-health",
    "@openmesh/observer-github",
  ];
  for (const name of mods) {
    try {
      const mod = await import(name);
      observers.push(mod.default);
    } catch { /* not installed */ }
  }
  return observers;
}

async function loadBundledOperators(): Promise<Operator[]> {
  const operators: Operator[] = [];
  const mods = [
    ["@openmesh/operator-code", "code"],
    ["@openmesh/operator-comms", "comms"],
    ["@openmesh/operator-infra", "infra"],
    ["@openmesh/operator-data", "data"],
  ] as const;

  for (const [name] of mods) {
    try {
      const mod = await import(name);
      operators.push(mod.default);
    } catch { /* not installed */ }
  }
  return operators;
}
