# OpenMesh

![CI](https://github.com/thebotclub/openmesh/actions/workflows/ci.yml/badge.svg)
![Coverage](https://img.shields.io/badge/coverage-75%25-brightgreen)

[open-mesh.ai](https://open-mesh.ai)

AI-native operations platform. Declare **what** your infrastructure should do — OpenMesh figures out **how**.

## Architecture

```
                    ┌────────────────────────────────────────────┐
                    │              OpenMesh Runtime               │
                    │                                            │
  Observers ──────→ EventBus (WAL) ──→ GoalEngine ──→ Operators  │
    cron             durable JSONL       YAML goals     code     │
    http-health      glob matching       conditions     comms    │
    github           dedup               templates      infra    │
    slack            anomaly detect      escalation     data     │
    log-stream       ↑                   AI planning    AI 🧠   │
    channels ←──────←┘                                  channels │
                    │                                            │
                    │  ┌─── Integrations ─────────────────────┐  │
                    │  │ @openmesh/ai        → LiteLLM proxy  │  │
                    │  │ @openmesh/mcp       → MCP servers    │  │
                    │  │ @openmesh/channels  → Slack/Discord/  │  │
                    │  │                       Telegram/Webhook│  │
                    │  │ @openmesh/telemetry → OTel + Pino    │  │
                    │  │ @openmesh/plugins   → npm/local      │  │
                    │  └──────────────────────────────────────┘  │
                    └────────────────────────────────────────────┘
```

**Observers** watch your world and emit events.
**Goals** (YAML) declare which events matter and what steps to take.
**Operators** execute the steps — investigate code, send notifications, manage infra, query data.
The **EventBus** ties it all together with durable persistence and glob-based routing.
The **AI engine** understands natural language, interprets goals, detects anomalies, and reasons about problems.
**MCP** exposes operators as tools for any MCP client (Claude, Cursor, etc.) and imports external tools.
**Channels** bridge messages across Slack, Discord, Telegram, and webhooks.

## Quick Start

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Initialize a project
node packages/cli/dist/main.js init

# Run the mesh (cron observer fires immediately)
node packages/cli/dist/main.js run

# Run with AI, channels, and telemetry
node packages/cli/dist/main.js run --ai --channels --telemetry

# Inject a test event manually
node packages/cli/dist/main.js inject cron.tick

# Check status
node packages/cli/dist/main.js status

# View event log
node packages/cli/dist/main.js logs
```

## Writing Goals

Goals live in `goals/*.yaml`. Here's a complete example:

```yaml
id: build-repair
description: Investigate and report CI build failures

observe:
  - type: ci.build.failed
    where:
      repo: my-app

then:
  - label: investigate
    operator: code
    task: "Investigate CI failure for {{event.source}} — {{event.payload.error}}"

  - label: notify
    operator: comms
    task: "Build failure report: {{steps.investigate.summary}}"
    when: "investigate.status == 'success'"

escalate:
  afterFailures: 3
  channel: slack
  to: "#oncall"
```

### Goal YAML Reference

| Field | Description |
|-------|-------------|
| `id` | Unique goal identifier |
| `description` | Human-readable description |
| `observe` | Array of event patterns (`type` glob + optional `where` clause) |
| `then` | Array of steps: `label`, `operator`, `task` (with `{{event.*}}` / `{{steps.*}}` templates) |
| `then[].when` | Condition: `"stepLabel.status == 'success'"` |
| `then[].retry` | Retry policy: `maxRetries`, `delayMs`, `backoffMultiplier`, `maxDelayMs` |
| `escalate` | Auto-escalation after N consecutive failures |
| `dedupWindowMs` | Deduplication window in ms |

### Template Variables

- `{{event.type}}` — event type
- `{{event.source}}` — event source
- `{{event.timestamp}}` — ISO timestamp
- `{{event.payload.anyField}}` — event payload fields
- `{{steps.labelName.status}}` — prior step status (`success`, `failure`, `timeout`, `denied`)
- `{{steps.labelName.summary}}` — prior step summary text
- `{{steps.labelName.data.key}}` — prior step structured data

## Project Structure

```
packages/
  core/           # EventBus, GoalEngine, StateStore, Mesh runtime
  sdk/            # defineObserver(), defineOperator(), defineGoal()
  cli/            # mesh init|run|inject|status|logs|ai|mcp|channels|plugin
  dashboard/      # Web UI with live SSE updates
  ai/             # LLM engine, goal interpreter, planner, anomaly detection
  mcp/            # MCP server (expose operators) + client (import tools)
  channels/       # Multi-channel messaging: Slack, Discord, Telegram, webhook
  telemetry/      # OpenTelemetry traces/metrics + Pino structured logging
  plugins/        # Dynamic plugin loading from npm or local directories
  observers/
    cron/          # Interval-based scheduler
    http-health/   # HTTP endpoint polling
    github/        # GitHub webhook server
    slack/         # Slack Events API (HTTP with signature verification)
    log-stream/    # Log file tailing with pattern detection
  operators/
    code/          # Code analysis, search, test runner, git diff
    comms/         # Notifications (stdout, future: Slack/email/PagerDuty)
    infra/         # Infrastructure commands with allowlist + approval
    data/          # File read, count, grep, directory stats
```

## Features

### Retry & Backoff

Steps can declare a retry policy for transient failures:

```yaml
then:
  - label: deploy
    operator: infra
    task: "exec: kubectl rollout restart deployment/my-app"
    retry:
      maxRetries: 3
      delayMs: 1000
      backoffMultiplier: 2.0
      maxDelayMs: 30000
```

### Escalation

Goals can auto-escalate to a channel after N consecutive failures:

```yaml
escalate:
  afterFailures: 3
  channel: slack
  to: "#oncall"
```

### Dashboard

Launch the web dashboard alongside the mesh:

```bash
node packages/cli/dist/main.js run --dashboard --dashboard-port 3777
```

The dashboard shows:
- **Goals** — loaded YAML goals with their observation patterns and steps
- **Recent Events** — live event stream from the WAL
- **Execution Log** — state checkpoints (matches, step results, completions)
- **SSE** — automatic live updates via Server-Sent Events

### AI-Powered Goals (`@openmesh/ai`)

Uses the OpenAI SDK pointed at [LiteLLM](https://github.com/BerriAI/litellm) (or any OpenAI-compatible endpoint: Ollama, vLLM, OpenRouter, direct OpenAI/Anthropic).

```bash
# Set your LLM endpoint (LiteLLM proxy, Ollama, OpenAI, etc.)
export OPENMESH_LLM_BASE_URL=http://localhost:4000/v1   # LiteLLM
export OPENMESH_LLM_API_KEY=sk-...
export OPENMESH_LLM_MODEL=gpt-4o

# Convert natural language to a goal
mesh ai interpret "When a GitHub push fails CI, analyze the logs and notify #engineering on Slack"

# Save the interpreted goal directly
mesh ai interpret "Monitor HTTP health every 5 minutes and restart if down" --save

# Analyze events for anomalies
mesh ai analyze --window 100

# Use the AI operator in goal YAML
```

```yaml
then:
  - label: diagnose
    operator: ai
    task: "Analyze this failure and suggest root causes: {{event.payload.error}}"
```

### Model Context Protocol (`@openmesh/mcp`)

Expose the entire mesh as an MCP server for Claude, Cursor, or any MCP client:

```bash
# Serve mesh operators as MCP tools
mesh mcp serve

# Connect an external MCP server's tools as mesh operators
mesh mcp connect npx -y @modelcontextprotocol/server-filesystem /tmp
```

### Multi-Channel Messaging (`@openmesh/channels`)

Configure channels in `mesh.config.json`:

```json
{
  "channels": {
    "slack": { "botToken": "xoxb-...", "defaultChannel": "#ops" },
    "discord": { "botToken": "...", "guildId": "...", "channelId": "..." },
    "telegram": { "botToken": "...", "chatId": "..." },
    "webhook": { "port": 3780, "endpoints": [] }
  }
}
```

```bash
# Run with channels enabled
mesh run --channels

# Test a channel
mesh channels test slack "Hello from OpenMesh!"

# Use in goals — send alerts anywhere
```

```yaml
then:
  - label: alert
    operator: channels
    task: "Send to slack: Build {{event.payload.repo}} failed — {{steps.investigate.summary}}"
```

### Plugins

```bash
# Load a local plugin directory
mesh plugin load ./my-plugin

# Install from npm
mesh plugin install openmesh-plugin-kubernetes

# Run with plugins
mesh run --plugins ./my-plugin ./another-plugin
```

### Telemetry

```bash
# Enable OpenTelemetry traces + metrics
mesh run --telemetry

# Configure OTLP exporter
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

### Open Source Leverage

OpenMesh doesn't reinvent the wheel. We integrate with best-in-class open source:

| Capability | Integration | Why |
|-----------|------------|-----|
| LLM routing | [LiteLLM](https://github.com/BerriAI/litellm) via OpenAI SDK | 100+ providers, cost tracking, load balancing, caching |
| Tool interop | [MCP SDK](https://github.com/modelcontextprotocol/sdk) | Standard protocol for sharing tools across AI ecosystem |
| Observability | [OpenTelemetry](https://opentelemetry.io/) + [Pino](https://getpino.io/) | Industry-standard traces, metrics, structured logs |
| Schema validation | [Zod](https://zod.dev/) | TypeScript-first runtime validation |
| Messaging APIs | Direct HTTP (Slack, Discord, Telegram) | Lightweight, no heavy SDK dependencies |

### Persistent State

All events and state checkpoints are persisted as JSONL files:
- `events.wal.jsonl` — durable event write-ahead log
- `state.jsonl` — execution state (goal matches, step results, completions)

State is restored on restart, so the mesh can pick up where it left off.

## Development

```bash
# Tests (75 passing across 10 files)
npx vitest run

# Build all packages
pnpm build

# Run CLI in development
node packages/cli/dist/main.js --help
```

## License

MIT
