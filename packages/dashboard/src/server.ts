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

  return {
    port,
    close: () => {
      clearInterval(pollInterval);
      for (const client of sseClients) client.end();
      server.close();
    },
  };
}
