# OpenMesh Roadmap

## ✅ Phase 1 — Foundation (Complete)

- Monorepo scaffold (pnpm workspaces, TypeScript ESM, Vitest)
- Core EventBus with WAL-backed persistence
- GoalEngine with YAML goal definitions
- SDK: `defineObserver()`, `defineOperator()`, `defineGoal()`
- CLI skeleton: `mesh init`, `mesh run`, `mesh inject`
- Basic observers (cron, http-health, github) and operators (comms)
- 36 tests passing, E2E demo verified

## ✅ Phase 2 — Real Implementations (Complete)

- **Log-stream observer** — file tailing with regex pattern matching
- **Slack observer** — Events API with HTTP server + HMAC signature verification
- **Infra operator** — command execution with allowlist + approval workflow
- **Data operator** — file read, line count, grep, stats
- **Code operator** — analyze, search, test runner, diff
- **Persistent StateStore** — disk-backed JSONL with restore on startup
- **Dashboard** — HTTP server with SSE, dark-themed live UI (goals, events, execution panels)
- **Retry/backoff** — exponential backoff with configurable RetryPolicy per goal
- **Goal escalation chains** — auto-notify comms operator after N failures
- **Multi-goal E2E scenarios** — 3 production YAML templates + 5 E2E tests
- 75 tests across 10 files, 13 packages building clean

## 🔲 Phase 3 — Production Readiness

### 3.1 CI/CD Pipeline
- [x] GitHub Actions: test, build, type-check on PR/push
- [ ] Coverage badge in README
- [x] Automated npm publish on release tags (`v*` tag → pnpm publish)

### 3.2 AI/LLM Integration (`@openmesh/ai`) — ✅ SCAFFOLDED
- [x] AI engine via OpenAI SDK → LiteLLM proxy (100+ model providers)
- [x] Natural language → Goal YAML interpreter (`mesh ai interpret`)
- [x] Intelligent operator planner — AI selects operators, generates plans
- [x] Anomaly detector on observation streams (`mesh ai analyze`)
- [x] AI reasoning operator (`ai` operator in goals)
- [x] Conversational goal refinement via CLI (`mesh ai refine` — multi-turn interactive sessions)
- [x] RAG context from state/event history (`RAGContextBuilder` with events, checkpoints, goal states)
- [ ] Fine-tuned prompt templates per domain

### 3.3 Model Context Protocol (`@openmesh/mcp`) — ✅ SCAFFOLDED
- [x] MCP server — expose mesh operators as MCP tools (`mesh mcp serve`)
- [x] MCP client — import external MCP server tools as operators (`mesh mcp connect`)
- [x] Remote MCP server transport (SSE + HTTP POST with auth & CORS)
- [ ] MCP resource exposure (state, events, goals)
- [ ] MCP prompt templates for goal creation

### 3.4 Multi-Channel Messaging (`@openmesh/channels`) — ✅ SCAFFOLDED
- [x] Channel router hub with adapter pattern
- [x] Webhook adapter (HTTP inbound/outbound)
- [x] Slack adapter (Web API + polling)
- [x] Discord adapter (Gateway WebSocket + REST)
- [x] Telegram adapter (Bot API long polling)
- [x] Channel observer (emits events into mesh)
- [x] Channel operator (sends messages from goals)
- [ ] Matrix bridge adapter (unifies all messaging)
- [ ] Email (SMTP/IMAP) adapter
- [ ] PagerDuty / OpsGenie adapter
- [ ] Interactive message actions (buttons, approvals)

### 3.5 Observability (`@openmesh/telemetry`) — ✅ SCAFFOLDED
- [x] Structured logging via Pino
- [x] OpenTelemetry traces (event → goal → operator spans)
- [x] OpenTelemetry metrics (event count, goal executions, operator duration)
- [x] Combined telemetry setup utility
- [x] Prometheus /metrics endpoint (exposition format, MetricsRegistry, HTTP server)
- [ ] Dashboard metrics panels
- [ ] Grafana dashboard templates

### 3.6 Plugin System (`@openmesh/plugins`) — ✅ SCAFFOLDED
- [x] Dynamic ESM plugin loading from local dirs or npm
- [x] Plugin manifest format (`openmesh-plugin.json`)
- [x] `mesh plugin load <path>` CLI command
- [x] `mesh plugin install <name>` CLI command
- [x] Plugin registry with mesh wiring
- [ ] Plugin dependency resolution
- [ ] Plugin marketplace / discovery

### 3.7 Docker & Deployment
- [x] Dockerfile + docker-compose for self-hosted deployment (mesh + LiteLLM + OTel)
- [ ] `npx @openmesh/cli` global install path
- [ ] Helm chart for Kubernetes
- [ ] One-click deploy templates (Railway, Fly.io, Render)

### 3.8 Authentication & Secrets
- [x] Dashboard auth (API key authentication with timing-safe comparison)
- [ ] Secrets manager integration (env vars, Vault, 1Password)
- [ ] Scoped operator permissions beyond the current allowlist
- [ ] Audit log for operator actions

### 3.9 Documentation Site
- [ ] Host on open-mesh.ai
- [ ] Getting started guide
- [ ] API reference (SDK, CLI)
- [ ] Goal template library with examples
- [ ] Contributing guide

## 🔲 Phase 4 — Scale & Ecosystem

- [ ] Multi-node mesh coordination (distributed EventBus)
- [ ] Goal dependencies and DAG execution
- [ ] Webhook-based observer gateway
- [ ] Visual goal editor (drag-and-drop)
- [ ] Community plugin marketplace
- [ ] Role-based access control (RBAC)
- [ ] SaaS hosted offering
