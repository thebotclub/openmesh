import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateRequest, type AuthConfig } from "./auth.js";

export interface DashboardConfig {
  port?: number;
  dataDir?: string;
  goalsDir?: string;
  /** API keys for dashboard authentication. If empty/undefined, auth is disabled. */
  apiKeys?: string[];
}

/** Parse goals from YAML dir (reuse loader from core if available) */
function loadGoalSummaries(goalsDir: string): Array<{ id: string; description: string; observes: string[]; steps: string[] }> {
  if (!existsSync(goalsDir)) return [];
  try {
    // Dynamic import to avoid hard dep — works at runtime since core is always present
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const files = readdirSync(goalsDir).filter((f: string) => f.endsWith(".yaml") || f.endsWith(".yml"));
    return files.map((f: string) => {
      const content = readFileSync(join(goalsDir, f), "utf-8");
      const id = /^id:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? f;
      const description = /^description:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? "";
      const observes = [...content.matchAll(/type:\s*"?([^"\n]+)"?/g)].map(m => m[1]!.trim());
      const steps = [...content.matchAll(/label:\s*(\S+)/g)].map(m => m[1]!);
      return { id, description, observes, steps };
    });
  } catch {
    return [];
  }
}

function loadEvents(dataDir: string, limit = 50): Array<Record<string, unknown>> {
  const walPath = join(dataDir, "events.wal.jsonl");
  if (!existsSync(walPath)) return [];
  const content = readFileSync(walPath, "utf-8").trim();
  if (!content) return [];
  const lines = content.split("\n");
  return lines.slice(-limit).map(line => {
    try { return JSON.parse(line) as Record<string, unknown>; }
    catch { return { raw: line }; }
  });
}

function loadState(dataDir: string, limit = 100): Array<Record<string, unknown>> {
  const statePath = join(dataDir, "state.jsonl");
  if (!existsSync(statePath)) return [];
  const content = readFileSync(statePath, "utf-8").trim();
  if (!content) return [];
  const lines = content.split("\n");
  return lines.slice(-limit).map(line => {
    try { return JSON.parse(line) as Record<string, unknown>; }
    catch { return { raw: line }; }
  });
}

// ── Metrics computation ────────────────────────────────────────────

export interface DashboardMetrics {
  events: {
    total: number;
    byType: Record<string, number>;
    recentRate: number;
    timeline: Array<{ time: string; count: number }>;
  };
  goals: {
    total: number;
    active: number;
    byStatus: Record<string, number>;
  };
  operators: {
    total: number;
    executions: number;
    avgDurationMs: number;
    byOperator: Record<string, { executions: number; avgMs: number; errors: number }>;
  };
  system: {
    uptimeMs: number;
    memoryMb: number;
    eventBusSize: number;
    stateCheckpoints: number;
  };
}

const startTime = Date.now();

export function computeMetrics(dataDir: string): DashboardMetrics {
  const allEvents = loadEvents(dataDir, 100_000);
  const allCheckpoints = loadState(dataDir, 100_000);

  // ── Events ──
  const byType: Record<string, number> = {};
  for (const e of allEvents) {
    const t = (e.type as string) ?? "unknown";
    byType[t] = (byType[t] ?? 0) + 1;
  }

  // Recent rate: events in last 5 minutes
  const fiveMinAgo = Date.now() - 5 * 60_000;
  const recentEvents = allEvents.filter(e => {
    const ts = e.timestamp as string | undefined;
    return ts ? new Date(ts).getTime() > fiveMinAgo : false;
  });
  const recentRate = recentEvents.length / 5; // per minute

  // Timeline: 1-min buckets for last 30 minutes
  const thirtyMinAgo = Date.now() - 30 * 60_000;
  const buckets = new Map<string, number>();
  for (let i = 0; i < 30; i++) {
    const t = new Date(thirtyMinAgo + i * 60_000);
    const key = t.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
    buckets.set(key, 0);
  }
  for (const e of allEvents) {
    const ts = e.timestamp as string | undefined;
    if (!ts) continue;
    const key = ts.slice(0, 16);
    if (buckets.has(key)) {
      buckets.set(key, buckets.get(key)! + 1);
    }
  }
  const timeline = [...buckets.entries()].map(([time, count]) => ({ time, count }));

  // ── Goals ──
  const goalStatuses: Record<string, number> = {};
  let activeGoals = 0;
  const goalStates = new Map<string, string>();
  for (const c of allCheckpoints) {
    const kind = c.kind as string | undefined;
    const goalId = c.goalId as string | undefined;
    if (!kind || !goalId) continue;
    if (kind === "goal_matched") {
      goalStates.set(goalId, "active");
    } else if (kind === "goal_completed") {
      const status = (c.result as Record<string, unknown>)?.status as string ?? "success";
      goalStates.set(goalId, status);
      goalStatuses[status] = (goalStatuses[status] ?? 0) + 1;
    } else if (kind === "goal_failed") {
      goalStates.set(goalId, "failure");
      goalStatuses["failure"] = (goalStatuses["failure"] ?? 0) + 1;
    }
  }
  for (const st of goalStates.values()) {
    if (st === "active") activeGoals++;
  }

  // ── Operators ──
  const opStats = new Map<string, { executions: number; totalMs: number; errors: number }>();
  for (const c of allCheckpoints) {
    const kind = c.kind as string | undefined;
    if (kind !== "step_completed") continue;
    const label = (c.stepLabel as string) ?? "unknown";
    const dur = (c.durationMs as number) ?? 0;
    const status = (c.result as Record<string, unknown>)?.status as string ?? "success";
    const entry = opStats.get(label) ?? { executions: 0, totalMs: 0, errors: 0 };
    entry.executions++;
    entry.totalMs += dur;
    if (status === "error" || status === "failure") entry.errors++;
    opStats.set(label, entry);
  }

  let totalExec = 0;
  let totalDur = 0;
  const byOperator: Record<string, { executions: number; avgMs: number; errors: number }> = {};
  for (const [op, s] of opStats) {
    totalExec += s.executions;
    totalDur += s.totalMs;
    byOperator[op] = {
      executions: s.executions,
      avgMs: s.executions > 0 ? Math.round(s.totalMs / s.executions) : 0,
      errors: s.errors,
    };
  }

  // ── System ──
  const mem = process.memoryUsage();

  return {
    events: {
      total: allEvents.length,
      byType,
      recentRate: Math.round(recentRate * 100) / 100,
      timeline,
    },
    goals: {
      total: goalStates.size,
      active: activeGoals,
      byStatus: goalStatuses,
    },
    operators: {
      total: opStats.size,
      executions: totalExec,
      avgDurationMs: totalExec > 0 ? Math.round(totalDur / totalExec) : 0,
      byOperator,
    },
    system: {
      uptimeMs: Date.now() - startTime,
      memoryMb: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
      eventBusSize: allEvents.length,
      stateCheckpoints: allCheckpoints.length,
    },
  };
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenMesh Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; background: #0d1117; color: #c9d1d9; }
    header { background: #161b22; border-bottom: 1px solid #30363d; padding: 16px 24px; display: flex; align-items: center; gap: 16px; }
    header h1 { font-size: 20px; color: #58a6ff; }
    header .status { font-size: 12px; padding: 4px 10px; border-radius: 12px; background: #238636; color: #fff; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
    .card h2 { font-size: 14px; text-transform: uppercase; color: #8b949e; margin-bottom: 12px; letter-spacing: 1px; }
    .goal { padding: 10px 0; border-bottom: 1px solid #21262d; }
    .goal:last-child { border-bottom: none; }
    .goal-id { color: #58a6ff; font-weight: 600; }
    .goal-desc { color: #8b949e; font-size: 13px; }
    .goal-meta { font-size: 12px; color: #484f58; margin-top: 4px; }
    .event { padding: 6px 0; border-bottom: 1px solid #21262d; font-size: 13px; font-family: monospace; }
    .event:last-child { border-bottom: none; }
    .event-type { color: #d2a8ff; }
    .event-time { color: #484f58; }
    .event-source { color: #7ee787; }
    .checkpoint { padding: 6px 0; border-bottom: 1px solid #21262d; font-size: 13px; }
    .checkpoint:last-child { border-bottom: none; }
    .kind { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .kind-observation { background: #1f6feb33; color: #58a6ff; }
    .kind-goal_matched { background: #23863633; color: #7ee787; }
    .kind-step_started { background: #d2a8ff33; color: #d2a8ff; }
    .kind-step_completed { background: #23863633; color: #3fb950; }
    .kind-goal_completed { background: #23863633; color: #238636; }
    .kind-goal_failed { background: #da363433; color: #f85149; }
    .empty { color: #484f58; font-style: italic; }
    .refresh-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .refresh-bar button { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 6px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; }
    .refresh-bar button:hover { background: #30363d; }
    .live-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #238636; animation: pulse 2s infinite; margin-right: 6px; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .full-width { grid-column: 1 / -1; }
    .section-title { font-size: 18px; color: #58a6ff; margin: 32px 0 16px; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
    .stats-row { display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
    .stat-box { flex: 1; min-width: 140px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; text-align: center; }
    .stat-value { font-size: 28px; font-weight: 700; color: #58a6ff; }
    .stat-label { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 1px; margin-top: 4px; }
    .bar-chart { margin: 8px 0; }
    .bar-row { display: flex; align-items: center; margin: 4px 0; font-size: 13px; }
    .bar-label { width: 120px; color: #8b949e; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; flex-shrink: 0; }
    .bar-track { flex: 1; background: #21262d; border-radius: 4px; height: 18px; overflow: hidden; position: relative; margin: 0 8px; }
    .bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
    .bar-value { width: 50px; text-align: right; color: #c9d1d9; flex-shrink: 0; }
    .op-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .op-table th { text-align: left; color: #8b949e; font-weight: 600; padding: 8px; border-bottom: 1px solid #30363d; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
    .op-table td { padding: 8px; border-bottom: 1px solid #21262d; }
    .op-table tr:last-child td { border-bottom: none; }
    .timeline-chart { display: flex; align-items: flex-end; gap: 2px; height: 60px; margin: 8px 0; }
    .timeline-bar { flex: 1; background: #1f6feb; border-radius: 2px 2px 0 0; min-width: 4px; transition: height 0.3s; }
    @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>⬡ OpenMesh</h1>
    <span class="status" id="status">Connecting...</span>
  </header>
  <div class="container">
    <div class="refresh-bar">
      <div><span class="live-dot"></span>Live updates via SSE</div>
      <button onclick="location.reload()">Refresh</button>
    </div>
    <div class="grid">
      <div class="card">
        <h2>Goals</h2>
        <div id="goals"><div class="empty">Loading...</div></div>
      </div>
      <div class="card">
        <h2>Recent Events</h2>
        <div id="events"><div class="empty">No events yet</div></div>
      </div>
      <div class="card full-width">
        <h2>Execution Log</h2>
        <div id="checkpoints"><div class="empty">No checkpoints yet</div></div>
      </div>
    </div>

    <h3 class="section-title">Metrics</h3>
    <div class="stats-row" id="system-stats">
      <div class="stat-box"><div class="stat-value" id="stat-uptime">-</div><div class="stat-label">Uptime</div></div>
      <div class="stat-box"><div class="stat-value" id="stat-memory">-</div><div class="stat-label">Memory (MB)</div></div>
      <div class="stat-box"><div class="stat-value" id="stat-events">-</div><div class="stat-label">Total Events</div></div>
      <div class="stat-box"><div class="stat-value" id="stat-rate">-</div><div class="stat-label">Events/min</div></div>
    </div>

    <div class="grid">
      <div class="card">
        <h2>Event Timeline (30 min)</h2>
        <div id="event-timeline" class="timeline-chart"><div class="empty">No data</div></div>
      </div>
      <div class="card">
        <h2>Events by Type</h2>
        <div id="events-by-type" class="bar-chart"><div class="empty">No data</div></div>
      </div>
      <div class="card">
        <h2>Goals by Status</h2>
        <div id="goals-by-status" class="bar-chart"><div class="empty">No data</div></div>
      </div>
      <div class="card">
        <h2>Goal Summary</h2>
        <div class="stats-row">
          <div class="stat-box"><div class="stat-value" id="stat-goals-total">-</div><div class="stat-label">Total</div></div>
          <div class="stat-box"><div class="stat-value" id="stat-goals-active">-</div><div class="stat-label">Active</div></div>
        </div>
      </div>
      <div class="card full-width">
        <h2>Operator Execution Stats</h2>
        <div id="operator-stats"><div class="empty">No operator data</div></div>
      </div>
    </div>
  </div>
  <script>
    async function fetchData() {
      try {
        const res = await fetch('/api/state');
        const data = await res.json();
        renderGoals(data.goals);
        renderEvents(data.events);
        renderCheckpoints(data.checkpoints);
        document.getElementById('status').textContent = 'Connected';
        document.getElementById('status').style.background = '#238636';
      } catch {
        document.getElementById('status').textContent = 'Disconnected';
        document.getElementById('status').style.background = '#da3634';
      }
    }

    function renderGoals(goals) {
      const el = document.getElementById('goals');
      if (!goals.length) { el.innerHTML = '<div class="empty">No goals loaded</div>'; return; }
      el.innerHTML = goals.map(g => \`
        <div class="goal">
          <div class="goal-id">\${g.id}</div>
          <div class="goal-desc">\${g.description}</div>
          <div class="goal-meta">observes: \${g.observes.join(', ')} &bull; steps: \${g.steps.join(' → ')}</div>
        </div>
      \`).join('');
    }

    function renderEvents(events) {
      const el = document.getElementById('events');
      if (!events.length) { el.innerHTML = '<div class="empty">No events yet</div>'; return; }
      el.innerHTML = events.reverse().map(e => \`
        <div class="event">
          <span class="event-time">\${(e.timestamp || '').slice(11, 23)}</span>
          <span class="event-source">[\${e.source}]</span>
          <span class="event-type">\${e.type}</span>
        </div>
      \`).join('');
    }

    function renderCheckpoints(checkpoints) {
      const el = document.getElementById('checkpoints');
      if (!checkpoints.length) { el.innerHTML = '<div class="empty">No checkpoints yet</div>'; return; }
      el.innerHTML = checkpoints.reverse().slice(0, 30).map(c => \`
        <div class="checkpoint">
          <span class="event-time">\${(c.timestamp || '').slice(11, 23)}</span>
          <span class="kind kind-\${c.kind}">\${c.kind}</span>
          \${c.goalId ? '<span style="color:#8b949e"> ' + c.goalId + '</span>' : ''}
          \${c.stepLabel ? '<span style="color:#484f58"> → ' + c.stepLabel + '</span>' : ''}
          \${c.result ? '<span style="color:' + (c.result.status === 'success' ? '#3fb950' : '#f85149') + '"> ' + c.result.status + '</span>' : ''}
        </div>
      \`).join('');
    }

    // SSE for live updates
    const sse = new EventSource('/api/stream');
    sse.onmessage = () => fetchData();
    sse.onerror = () => {
      document.getElementById('status').textContent = 'Reconnecting...';
      document.getElementById('status').style.background = '#d29922';
    };

    fetchData();
    setInterval(fetchData, 5000);

    async function fetchMetrics() {
      try {
        const res = await fetch('/api/metrics');
        const m = await res.json();
        renderSystemStats(m.system, m.events);
        renderTimeline(m.events.timeline);
        renderEventsByType(m.events.byType, m.events.total);
        renderGoalsByStatus(m.goals);
        renderOperatorStats(m.operators);
      } catch {}
    }

    function renderSystemStats(sys, events) {
      const h = Math.floor(sys.uptimeMs / 3600000);
      const min = Math.floor((sys.uptimeMs % 3600000) / 60000);
      document.getElementById('stat-uptime').textContent = h + 'h ' + min + 'm';
      document.getElementById('stat-memory').textContent = sys.memoryMb;
      document.getElementById('stat-events').textContent = events.total;
      document.getElementById('stat-rate').textContent = events.recentRate;
    }

    function renderTimeline(timeline) {
      const el = document.getElementById('event-timeline');
      if (!timeline.length) { el.innerHTML = '<div class="empty">No data</div>'; return; }
      const max = Math.max(...timeline.map(t => t.count), 1);
      el.innerHTML = timeline.map(t => {
        const pct = Math.max((t.count / max) * 100, 2);
        return '<div class="timeline-bar" style="height:' + pct + '%" title="' + t.time + ': ' + t.count + '"></div>';
      }).join('');
    }

    function renderEventsByType(byType, total) {
      const el = document.getElementById('events-by-type');
      const entries = Object.entries(byType).sort((a, b) => b[1] - a[1]);
      if (!entries.length) { el.innerHTML = '<div class="empty">No events</div>'; return; }
      const max = Math.max(...entries.map(e => e[1]), 1);
      el.innerHTML = entries.slice(0, 10).map(([type, count]) => {
        const pct = (count / max) * 100;
        return '<div class="bar-row">' +
          '<span class="bar-label">' + type + '</span>' +
          '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:#1f6feb"></div></div>' +
          '<span class="bar-value">' + count + '</span></div>';
      }).join('');
    }

    function renderGoalsByStatus(goals) {
      const el = document.getElementById('goals-by-status');
      document.getElementById('stat-goals-total').textContent = goals.total;
      document.getElementById('stat-goals-active').textContent = goals.active;
      const entries = Object.entries(goals.byStatus);
      if (!entries.length) { el.innerHTML = '<div class="empty">No goals completed</div>'; return; }
      const max = Math.max(...entries.map(e => e[1]), 1);
      const colors = { success: '#238636', failure: '#da3634', timeout: '#d29922' };
      el.innerHTML = entries.map(([status, count]) => {
        const pct = (count / max) * 100;
        const color = colors[status] || '#484f58';
        return '<div class="bar-row">' +
          '<span class="bar-label">' + status + '</span>' +
          '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
          '<span class="bar-value">' + count + '</span></div>';
      }).join('');
    }

    function renderOperatorStats(ops) {
      const el = document.getElementById('operator-stats');
      const entries = Object.entries(ops.byOperator);
      if (!entries.length) { el.innerHTML = '<div class="empty">No operator data</div>'; return; }
      el.innerHTML = '<table class="op-table"><thead><tr>' +
        '<th>Operator</th><th>Executions</th><th>Avg (ms)</th><th>Errors</th></tr></thead><tbody>' +
        entries.map(([name, s]) =>
          '<tr><td style="color:#d2a8ff">' + name + '</td><td>' + s.executions + '</td><td>' + s.avgMs + '</td>' +
          '<td style="color:' + (s.errors > 0 ? '#f85149' : '#484f58') + '">' + s.errors + '</td></tr>'
        ).join('') + '</tbody></table>';
    }

    fetchMetrics();
    setInterval(fetchMetrics, 5000);
  </script>
</body>
</html>`;

export function startDashboard(config: DashboardConfig = {}): { close: () => void; port: number } {
  const port = config.port ?? Number(process.env.OPENMESH_DASHBOARD_PORT) ?? 3777;
  const dataDir = resolve(config.dataDir ?? ".openmesh");
  const goalsDir = resolve(config.goalsDir ?? "goals");

  const authConfig: AuthConfig = { apiKeys: config.apiKeys };
  const sseClients = new Set<ServerResponse>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!validateRequest(req, authConfig)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const url = req.url ?? "/";

    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(HTML);
      return;
    }

    if (url === "/api/state") {
      const goals = loadGoalSummaries(goalsDir);
      const events = loadEvents(dataDir);
      const checkpoints = loadState(dataDir);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ goals, events, checkpoints }));
      return;
    }

    if (url === "/api/metrics") {
      const metrics = computeMetrics(dataDir);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(metrics));
      return;
    }

    if (url === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write("data: connected\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  server.listen(port, () => {
    console.log(`📊 OpenMesh Dashboard: http://localhost:${port}`);
  });

  // Poll for changes and notify SSE clients
  let lastEventCount = 0;
  let lastStateCount = 0;
  const pollInterval = setInterval(() => {
    const events = loadEvents(dataDir, 1000);
    const state = loadState(dataDir, 1000);
    if (events.length !== lastEventCount || state.length !== lastStateCount) {
      lastEventCount = events.length;
      lastStateCount = state.length;
      for (const client of sseClients) {
        client.write(`data: update\n\n`);
      }
    }
  }, 1000);

  const actualPort = (): number => {
    const addr = server.address();
    if (typeof addr === "object" && addr) return addr.port;
    return port;
  };

  return {
    get port() { return actualPort(); },
    close: () => {
      clearInterval(pollInterval);
      for (const client of sseClients) client.end();
      server.close();
    },
  };
}
