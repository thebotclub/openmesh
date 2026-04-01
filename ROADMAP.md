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
- [ ] GitHub Actions: test, build, lint on PR/push
- [ ] Coverage badge in README
- [ ] Automated npm publish on release tags

### 3.2 AI/LLM Integration
- [ ] LLM-powered goal interpretation — natural language → action plans
- [ ] Intelligent operator selection — AI picks which operator(s) to run
- [ ] Anomaly detection on observation streams
- [ ] Auto-remediation suggestions from incident patterns
- [ ] Conversational goal refinement via CLI

### 3.3 Docker & Deployment
- [ ] Dockerfile + docker-compose for self-hosted deployment
- [ ] `npx @openmesh/cli` global install path
- [ ] Helm chart for Kubernetes
- [ ] One-click deploy templates (Railway, Fly.io, Render)

### 3.4 Authentication & Secrets
- [ ] Dashboard auth (API keys / session tokens)
- [ ] Secrets manager integration (env vars, Vault, 1Password)
- [ ] Scoped operator permissions beyond the current allowlist
- [ ] Audit log for operator actions

### 3.5 Plugin System
- [ ] Dynamic observer/operator loading from npm or local paths
- [ ] Plugin manifest format (`openmesh-plugin.json`)
- [ ] `mesh plugin install <name>` CLI command
- [ ] Plugin registry / discovery

### 3.6 Observability
- [ ] Structured logging (pino)
- [ ] OpenTelemetry / Prometheus metrics export
- [ ] Dashboard metrics panels (event throughput, goal success rate, operator latency)
- [ ] Alerting rules and notification channels

### 3.7 Documentation Site
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
