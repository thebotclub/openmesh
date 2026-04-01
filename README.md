# OpenMesh

[open-mesh.ai](https://open-mesh.ai)

AI-native operations platform. Declare **what** your infrastructure should do — OpenMesh figures out **how**.

## Architecture

```
Observers  →  EventBus (WAL)  →  GoalEngine  →  Operators
  cron          durable JSONL       YAML goals      code
  http-health   glob matching       conditions      comms
  github        dedup               templates       infra
  slack                             escalation      data
```

**Observers** watch your world and emit events.
**Goals** (YAML) declare which events matter and what steps to take.
**Operators** execute the steps — investigate code, send notifications, manage infra, query data.
The **EventBus** ties it all together with durable persistence and glob-based routing.

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
  cli/            # mesh init|run|inject|status|logs
  dashboard/      # Web UI with live SSE updates
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
