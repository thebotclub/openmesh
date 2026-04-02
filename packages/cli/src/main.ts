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

function loadConfig(): Record<string, unknown> {
  const configPath = resolve("mesh.config.json");
  if (existsSync(configPath)) {
    return JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  }
  return {};
}

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
  .option("--ai", "Enable AI operator and anomaly detection", false)
  .option("--telemetry", "Enable OpenTelemetry traces and metrics", false)
  .option("--channels", "Enable multi-channel messaging from config", false)
  .option("--plugins <dirs...>", "Load plugins from local directories")
  .action(async (opts: {
    goals: string; data: string; logLevel: string;
    dashboard: boolean; dashboardPort: string;
    ai: boolean; telemetry: boolean; channels: boolean;
    plugins?: string[];
  }) => {
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

    // Wire AI operator if enabled
    if (opts.ai) {
      try {
        const { createAIOperator } = await import("@openmesh/ai/aiOperator");
        mesh.addOperator(createAIOperator());
        console.log("🧠 AI operator enabled");
      } catch {
        console.log("AI module not available (install @openmesh/ai)");
      }
    }

    // Wire telemetry if enabled
    if (opts.telemetry) {
      try {
        const { MeshTelemetry } = await import("@openmesh/telemetry/telemetry");
        const telemetry = new MeshTelemetry({
          serviceName: "openmesh",
          logLevel: opts.logLevel as "debug" | "info" | "warn" | "error",
        });
        console.log(`📊 Telemetry enabled (OTLP: ${process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "stdout"})`);
        // Store on mesh for later access
        (mesh as unknown as Record<string, unknown>)["telemetry"] = telemetry;
      } catch {
        console.log("Telemetry module not available (install @openmesh/telemetry)");
      }
    }

    // Wire multi-channel messaging if enabled
    if (opts.channels) {
      try {
        const { ChannelRouter } = await import("@openmesh/channels/router");
        const { createChannelObserver } = await import("@openmesh/channels/observer");
        const { createChannelOperator } = await import("@openmesh/channels/operator");

        const router = new ChannelRouter();
        const config = loadConfig();
        const channelConfig = (config["channels"] ?? {}) as Record<string, Record<string, unknown>>;

        for (const [name, cfg] of Object.entries(channelConfig)) {
          try {
            const adapterMod = await import(`@openmesh/channels/adapters/${name}`);
            const AdapterClass = adapterMod.default ?? Object.values(adapterMod)[0] as new (c: Record<string, unknown>) => { id: string; name: string; start: () => Promise<void>; send: (msg: unknown) => Promise<void>; stop: () => Promise<void> };
            router.addChannel(new AdapterClass(cfg));
            console.log(`📡 Channel enabled: ${name}`);
          } catch {
            console.log(`Channel adapter not found: ${name}`);
          }
        }

        mesh.addObserver(createChannelObserver(router));
        mesh.addOperator(createChannelOperator(router));
      } catch {
        console.log("Channels module not available (install @openmesh/channels)");
      }
    }

    // Load plugins if specified
    if (opts.plugins && opts.plugins.length > 0) {
      try {
        const { PluginRegistry } = await import("@openmesh/plugins/registry");
        const registry = new PluginRegistry();

        for (const pluginPath of opts.plugins) {
          try {
            await registry.loadLocal(resolve(pluginPath), mesh);
            console.log(`🔌 Plugin loaded: ${pluginPath}`);
          } catch (err) {
            console.log(`Plugin failed to load: ${pluginPath} — ${(err as Error).message}`);
          }
        }
      } catch {
        console.log("Plugins module not available (install @openmesh/plugins)");
      }
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

// ── mesh ai interpret ───────────────────────────────────────────────

const ai = program.command("ai").description("AI-powered goal management");

ai.command("interpret <text>")
  .description("Convert natural language into a goal YAML via LLM")
  .option("--model <model>", "LLM model to use")
  .option("--save", "Save the generated goal to the goals directory", false)
  .option("-g, --goals <dir>", "Goals directory", "goals")
  .action(async (text: string, opts: { model?: string; save: boolean; goals: string }) => {
    try {
      const { AIEngine } = await import("@openmesh/ai/engine");
      const { GoalInterpreter } = await import("@openmesh/ai/goalInterpreter");

      const engine = new AIEngine(opts.model ? { model: opts.model } : undefined);
      const interpreter = new GoalInterpreter(engine);
      const result = await interpreter.interpret(text);

      console.log(`\n📋 Interpreted Goal (confidence: ${(result.confidence * 100).toFixed(0)}%)`);
      console.log(`   ${result.explanation}\n`);
      console.log("---");
      // Output as YAML-ish display
      console.log(`id: ${result.goal.id}`);
      console.log(`description: ${result.goal.description}`);
      console.log("observe:");
      for (const o of result.goal.observe) {
        console.log(`  - type: "${o.type}"`);
      }
      console.log("then:");
      for (const step of result.goal.then) {
        console.log(`  - label: ${step.label}`);
        console.log(`    operator: ${step.operator}`);
        console.log(`    task: "${step.task}"`);
      }
      console.log("---");

      if (opts.save) {
        const goalsDir = resolve(opts.goals);
        if (!existsSync(goalsDir)) mkdirSync(goalsDir, { recursive: true });
        const filePath = join(goalsDir, `${result.goal.id}.yaml`);
        // Build a minimal YAML output
        let yaml = `id: ${result.goal.id}\n`;
        yaml += `description: ${result.goal.description}\n\n`;
        yaml += `observe:\n`;
        for (const o of result.goal.observe) {
          yaml += `  - type: "${o.type}"\n`;
        }
        yaml += `\nthen:\n`;
        for (const step of result.goal.then) {
          yaml += `  - label: ${step.label}\n`;
          yaml += `    operator: ${step.operator}\n`;
          yaml += `    task: "${step.task}"\n`;
        }
        writeFileSync(filePath, yaml);
        console.log(`\n✅ Goal saved to ${filePath}`);
      }
    } catch (err) {
      console.error("AI module not available. Install @openmesh/ai and configure LLM endpoint.");
      console.error((err as Error).message);
      process.exit(1);
    }
  });

ai.command("analyze")
  .description("Use AI to detect anomalies in recent events")
  .option("-d, --data <dir>", "Data directory", ".openmesh")
  .option("-w, --window <count>", "Number of recent events to analyze", "50")
  .action(async (opts: { data: string; window: string }) => {
    try {
      const { AIEngine } = await import("@openmesh/ai/engine");
      const { AnomalyDetector } = await import("@openmesh/ai/anomalyDetector");

      const engine = new AIEngine();
      const detector = new AnomalyDetector(engine, (a) => console.log(`⚠️  ${a.type}: ${a.description}`), { windowSizeMs: Number(opts.window) * 60_000 });

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

      const lines = content.split("\n").slice(-Number(opts.window));
      for (const line of lines) {
        try {
          const evt = JSON.parse(line);
          detector.observe(evt);
        } catch { /* skip */ }
      }

      console.log("🔍 Analyzing events for anomalies...\n");
      const anomalies = await detector.analyze();
      if (anomalies.length === 0) {
        console.log("✅ No anomalies detected.");
      } else {
        for (const a of anomalies) {
          console.log(`⚠️  [${a.severity}] ${a.type}: ${a.description}`);
          if (a.suggestedAction) console.log(`   → ${a.suggestedAction}`);
        }
      }
    } catch (err) {
      console.error("AI module not available. Install @openmesh/ai.");
      console.error((err as Error).message);
      process.exit(1);
    }
  });

ai.command("refine")
  .description("Interactively create and refine a goal via AI conversation")
  .option("--model <model>", "LLM model to use")
  .option("--save", "Save the generated goal to the goals directory", false)
  .option("-g, --goals <dir>", "Goals directory", "goals")
  .action(async (opts: { model?: string; save: boolean; goals: string }) => {
    try {
      const { RefineSession } = await import("@openmesh/ai/refineSession");
      const readline = await import("node:readline");

      const session = new RefineSession(opts.model ? { model: opts.model } : undefined);

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q: string): Promise<string> =>
        new Promise((res) => rl.question(q, (answer) => res(answer)));

      console.log("\n🧠 OpenMesh Goal Refiner");
      console.log("========================");
      console.log("Describe what you want your mesh to do in plain English.");
      console.log("I'll generate a structured goal, then you can refine it iteratively.\n");

      const description = await ask("Goal description: ");
      if (!description.trim()) {
        console.log("No description provided. Exiting.");
        rl.close();
        return;
      }

      console.log("\n⏳ Interpreting...\n");
      const initial = await session.start(description);

      console.log(`📋 Interpreted Goal (confidence: ${(initial.confidence * 100).toFixed(0)}%)`);
      console.log(`   ${initial.explanation}\n`);
      console.log("---");
      console.log(session.toYaml());
      console.log("---\n");

      // Refinement loop
      while (true) {
        const feedback = await ask("Feedback (or 'done' to save, 'quit' to exit): ");
        const trimmed = feedback.trim().toLowerCase();

        if (trimmed === "quit") {
          console.log("Exiting without saving.");
          break;
        }

        if (trimmed === "done") {
          const goalsDir = resolve(opts.goals);
          if (!existsSync(goalsDir)) mkdirSync(goalsDir, { recursive: true });
          const goal = session.getCurrentGoal()!;
          const filePath = join(goalsDir, `${goal.id}.yaml`);
          writeFileSync(filePath, session.toYaml() + "\n");
          console.log(`\n✅ Goal saved to ${filePath}`);
          break;
        }

        if (!trimmed) continue;

        console.log("\n⏳ Refining...\n");
        const refined = await session.refine(feedback);

        console.log(`📋 Refined Goal (confidence: ${(refined.confidence * 100).toFixed(0)}%)`);
        console.log(`   ${refined.explanation}\n`);
        console.log("---");
        console.log(session.toYaml());
        console.log("---\n");
      }

      rl.close();
    } catch (err) {
      console.error("AI module not available. Install @openmesh/ai and configure LLM endpoint.");
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── mesh mcp ────────────────────────────────────────────────────────

const mcp = program.command("mcp").description("Model Context Protocol integration");

mcp.command("serve")
  .description("Expose mesh operators as MCP tools via stdio")
  .option("-d, --data <dir>", "Data directory", ".openmesh")
  .option("-g, --goals <dir>", "Goals directory", "goals")
  .action(async (opts: { data: string; goals: string }) => {
    try {
      const { MeshMCPServer } = await import("@openmesh/mcp/server");
      const mesh = new Mesh({ dataDir: resolve(opts.data) });

      const operatorModules = await loadBundledOperators();
      for (const op of operatorModules) mesh.addOperator(op);

      const goalsDir = resolve(opts.goals);
      if (existsSync(goalsDir)) {
        const goals = loadGoalsFromDir(goalsDir);
        for (const goal of goals) mesh.addGoal(goal);
      }

      await mesh.start();

      const server = new MeshMCPServer(mesh);
      await server.start();
      // Server runs until stdin closes
    } catch (err) {
      console.error("MCP module not available. Install @openmesh/mcp.");
      console.error((err as Error).message);
      process.exit(1);
    }
  });

mcp.command("connect <command...>")
  .description("Connect an external MCP server and import its tools as operators")
  .option("-d, --data <dir>", "Data directory", ".openmesh")
  .action(async (command: string[], _opts: { data: string }) => {
    try {
      const { MeshMCPClient } = await import("@openmesh/mcp/client");

      const [cmd, ...args] = command;
      console.log(`Connecting to MCP server: ${cmd} ${args.join(" ")}`);

      const client = new MeshMCPClient({
        name: cmd!,
        command: cmd!,
        args,
      });
      await client.connect();
      const operators = await client.toOperators();

      console.log(`\n✅ Imported ${operators.length} MCP tool(s) as operators:`);
      for (const op of operators) {
        console.log(`  • ${op.id}: ${op.description}`);
      }

      await client.disconnect();
    } catch (err) {
      console.error("MCP module not available. Install @openmesh/mcp.");
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── mesh channels ───────────────────────────────────────────────────

const channels = program.command("channels").description("Multi-channel messaging");

channels.command("list")
  .description("List configured channels")
  .action(() => {
    const config = loadConfig();
    const channelConfig = (config["channels"] ?? {}) as Record<string, unknown>;
    const channelNames = Object.keys(channelConfig);

    if (channelNames.length === 0) {
      console.log("No channels configured. Add channels to mesh.config.json:");
      console.log('  "channels": { "slack": { "botToken": "..." }, "webhook": {} }');
      return;
    }

    console.log("Configured channels:");
    for (const name of channelNames) {
      console.log(`  • ${name}`);
    }
  });

channels.command("test <channel> <message>")
  .description("Send a test message to a specific channel")
  .action(async (channel: string, message: string) => {
    try {
      const { ChannelRouter } = await import("@openmesh/channels/router");

      const router = new ChannelRouter();
      const config = loadConfig();
      const channelConfig = (config["channels"] ?? {}) as Record<string, Record<string, unknown>>;

      if (!channelConfig[channel]) {
        console.error(`Channel "${channel}" not configured.`);
        process.exit(1);
      }

      // Load the appropriate adapter
      const adapterMod = await import(`@openmesh/channels/adapters/${channel}`);
      const AdapterClass = adapterMod.default ?? Object.values(adapterMod)[0] as new (config: Record<string, unknown>) => { id: string; name: string; start: () => Promise<void>; send: (msg: unknown) => Promise<void>; stop: () => Promise<void> };
      const adapter = new AdapterClass(channelConfig[channel]!);
      router.addChannel(adapter);

      await router.startAll();
      await router.send(channel, {
        channel,
        sender: "cli-test",
        text: message,
      });
      console.log(`✅ Message sent to ${channel}`);
      await router.stopAll();
    } catch (err) {
      console.error(`Failed to send message: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// ── mesh plugin ─────────────────────────────────────────────────────

const plugin = program.command("plugin").description("Plugin management");

plugin.command("load <path>")
  .description("Load and inspect a local plugin")
  .action(async (path: string) => {
    try {
      const { PluginLoader } = await import("@openmesh/plugins/loader");

      const loader = new PluginLoader();
      const pluginInfo = await loader.loadLocal(resolve(path));

      console.log(`\n📦 Plugin: ${pluginInfo.manifest.name} v${pluginInfo.manifest.version}`);
      console.log(`   ${pluginInfo.manifest.description}`);
      if (pluginInfo.observers.length > 0) {
        console.log(`   Observers: ${pluginInfo.observers.map((o: { id: string }) => o.id).join(", ")}`);
      }
      if (pluginInfo.operators.length > 0) {
        console.log(`   Operators: ${pluginInfo.operators.map((o: { id: string }) => o.id).join(", ")}`);
      }
      if (pluginInfo.goals.length > 0) {
        console.log(`   Goals: ${pluginInfo.goals.map((g: { id: string }) => g.id).join(", ")}`);
      }
    } catch (err) {
      console.error(`Failed to load plugin: ${(err as Error).message}`);
      process.exit(1);
    }
  });

plugin.command("install <name>")
  .description("Install a plugin from npm and register it")
  .action(async (name: string) => {
    try {
      const { PluginLoader } = await import("@openmesh/plugins/loader");

      console.log(`Installing ${name}...`);
      const loader = new PluginLoader();
      const pluginInfo = await loader.loadNpm(name);

      console.log(`\n✅ Installed: ${pluginInfo.manifest.name} v${pluginInfo.manifest.version}`);
      if (pluginInfo.observers.length > 0) {
        console.log(`   Observers: ${pluginInfo.observers.map((o: { id: string }) => o.id).join(", ")}`);
      }
      if (pluginInfo.operators.length > 0) {
        console.log(`   Operators: ${pluginInfo.operators.map((o: { id: string }) => o.id).join(", ")}`);
      }
    } catch (err) {
      console.error(`Failed to install plugin: ${(err as Error).message}`);
      process.exit(1);
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
