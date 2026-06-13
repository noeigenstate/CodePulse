<div align="center">

# CodePulse

**A local status hub for your AI coding agents.**

Know at a glance whether Codex and Claude Code are working, waiting on you,
finished, or stuck — without alt-tabbing back to a terminal.

[![status](https://img.shields.io/badge/status-v0.1%20MVP-orange)](#roadmap)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)](#building-a-distributable)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](#quick-start)
[![pnpm](https://img.shields.io/badge/pnpm-%E2%89%A59-F69220?logo=pnpm&logoColor=white)](#quick-start)
[![built with](https://img.shields.io/badge/built%20with-Electron%20%2B%20TypeScript-47848F?logo=electron&logoColor=white)](#how-it-works)

[English](./README.md) · [简体中文](./README.zh-CN.md) · [Product spec](./requirements.md)

</div>

---

AI coding agents are great at working unattended — and terrible at telling you
when they need you. CodePulse listens to the lifecycle hooks that Codex and
Claude Code already expose, runs every event through a single state machine,
and surfaces the result three ways:

- 📊 **Live Dashboard** — per-agent, per-workspace cards with state, activity,
  elapsed time, tool calls, context-window usage, and quota.
- 🎨 **Color-coded tray icon** — the overall state of every agent, visible at
  all times.
- 🔔 **Desktop notifications** — fired only when something actually needs you,
  with throttling and deduplication built in.

Everything runs **100% locally**. The server binds to loopback only, prompts
are stored as short previews (never in full), and the hooks fail silently when
CodePulse isn't running — your agents are never blocked or slowed down.

## Features

|                                     |                                                                                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 🚦 **Unified state machine**        | One turn lifecycle for every agent: idle → processing → tool running → waiting for permission/input → done / error / cancelled / stuck. |
| 🧭 **Multi-agent, multi-workspace** | Concurrent Codex and Claude Code sessions across projects, each tracked separately.                                                     |
| 📈 **Context & token tracking**     | Context-window usage from Claude's status line (exact) and Codex rollout files (estimated), with cost where available.                  |
| 🎟️ **Quota awareness**              | 5-hour / weekly rate-limit windows per quota bucket, matched to the model you're actually running.                                      |
| 🕰️ **Stuck detection**              | A watchdog flags turns with no activity so silent failures don't burn your afternoon.                                                   |
| 💾 **Local history**                | Events, sessions, turns, and token snapshots persisted to SQLite — yours to query or delete.                                            |
| 🔌 **Open local API**               | Plain HTTP + WebSocket on `127.0.0.1:17888`; build your own consumers (an ESP32 hardware client is on the roadmap).                     |

## How it works

```
 Codex / Claude Code
   │  lifecycle hooks & status line (dependency-free Node scripts)
   ▼
 POST /api/events ──► adapters ──► StatusHub (pure reducer + rule engine)
 (Fastify, loopback)   normalize        │
                                        ├─► SQLite (events / sessions / turns / tokens)
                                        ├─► tray icon update
                                        ├─► desktop notification
                                        └─► WebSocket / IPC push ──► Dashboard (React)
```

The repository is a `pnpm` workspace:

```
apps/desktop/        Electron app (main / preload / renderer)
packages/
  shared/            Domain types (Agent, Turn, AgentEvent, …) + constants
  core/              State machine, rule engine, aggregation, StatusHub
  adapters/          Codex / Claude raw payload → AgentEvent mapping
  storage/           SQLite schema (Drizzle ORM) + repository
  local-server/      Fastify HTTP + WebSocket routes
  hooks/             Standalone hook scripts the agents invoke
scripts/             Backend smoke test
tests/               Unit tests
```

**Stack:** Electron · electron-vite · TypeScript · React · Tailwind · Zustand ·
Fastify · better-sqlite3 · Drizzle ORM.

## Quick start

### Prerequisites

- **Node.js ≥ 20** (tested on 22.x)
- **pnpm ≥ 9** — `npm i -g pnpm`
- Windows users: `better-sqlite3` normally installs a prebuilt binary; see
  [Troubleshooting](#troubleshooting) if the database fails to load.

### Install & run

```bash
pnpm install
pnpm dev
```

You get a tray icon (grey = idle), the Dashboard window, and a local server on
`http://127.0.0.1:17888`. Closing the window keeps CodePulse running in the
tray; quit from the tray menu.

### Connect Claude Code

The hook scripts in `packages/hooks/bin/` are dependency-free and always exit
`0`, so they can never block or break the agent. Replace `<REPO>` with the
absolute path to this repository (on Windows, use double backslashes).

Merge the following into `~/.claude/settings.json`:

<details>
<summary><code>~/.claude/settings.json</code> (click to expand)</summary>

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "node <REPO>/packages/hooks/bin/claude-hook.js" },
        ],
      },
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "node <REPO>/packages/hooks/bin/claude-hook.js" },
        ],
      },
    ],
    "PreToolUse": [
      {
        "hooks": [
          { "type": "command", "command": "node <REPO>/packages/hooks/bin/claude-hook.js" },
        ],
      },
    ],
    "PostToolUse": [
      {
        "hooks": [
          { "type": "command", "command": "node <REPO>/packages/hooks/bin/claude-hook.js" },
        ],
      },
    ],
    "Notification": [
      {
        "hooks": [
          { "type": "command", "command": "node <REPO>/packages/hooks/bin/claude-hook.js" },
        ],
      },
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node <REPO>/packages/hooks/bin/claude-hook.js" },
        ],
      },
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "node <REPO>/packages/hooks/bin/claude-hook.js" },
        ],
      },
    ],
  },
  "statusLine": {
    "type": "command",
    "command": "node <REPO>/packages/hooks/bin/claude-statusline.js",
  },
}
```

</details>

The hooks report lifecycle events; the status line forwards token / context /
cost data to CodePulse **and** prints a compact line for Claude to display
(e.g. `⏺ Claude Sonnet · my-project · ctx 68%`).

### Connect Codex

Add command hooks to `~/.codex/hooks.json`:

<details>
<summary><code>~/.codex/hooks.json</code> (click to expand)</summary>

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [{ "type": "command", "command": "node <REPO>/packages/hooks/bin/codex-hook.js" }],
      },
    ],
    "UserPromptSubmit": [
      {
        "hooks": [{ "type": "command", "command": "node <REPO>/packages/hooks/bin/codex-hook.js" }],
      },
    ],
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "node <REPO>/packages/hooks/bin/codex-hook.js" }],
      },
    ],
    "PermissionRequest": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "node <REPO>/packages/hooks/bin/codex-hook.js" }],
      },
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "node <REPO>/packages/hooks/bin/codex-hook.js" }],
      },
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "node <REPO>/packages/hooks/bin/codex-hook.js" }],
      },
    ],
  },
}
```

</details>

Hooks are enabled by default in current Codex builds; if you disabled them,
re-enable with `hooks = true` under `[features]` in `~/.codex/config.toml`.
After adding or changing a hook, run `/hooks` inside Codex to review and trust
it.

> Codex has no status line, so the hook script reads token usage and quota
> from Codex's local rollout files on a best-effort basis (`accuracy:
estimated`).

### Verify

Run any task in either agent and watch the Dashboard light up — or send a
synthetic event:

```bash
curl -X POST http://127.0.0.1:17888/api/events \
  -H "content-type: application/json" \
  -d '{"source":"claude_code","hook_event_name":"UserPromptSubmit","session_id":"demo","cwd":"/tmp/demo","prompt":"hello"}'

curl http://127.0.0.1:17888/api/status
```

## Tray states

| Color     | Meaning                                     |
| --------- | ------------------------------------------- |
| ⚪ Grey   | All idle                                    |
| 🔵 Blue   | A task is running                           |
| 🟡 Yellow | Waiting for permission or input — needs you |
| 🟢 Green  | A turn finished, unread                     |
| 🔴 Red    | An error                                    |
| 🟠 Orange | Suspected stuck                             |

Notifications are throttled and deduplicated so you're informed, not nagged.
**Mute** (tray or header button) silences sound for 30 minutes; notifications
still appear, just silently.

## Local API

Loopback-only (`127.0.0.1:17888`) — never exposed to the network. Point the
hooks elsewhere with the `CODEPULSE_URL` environment variable.

| Method | Path                 | Purpose                                           |
| ------ | -------------------- | ------------------------------------------------- |
| `POST` | `/api/events`        | Ingest a raw hook payload (or an array, max 1000) |
| `GET`  | `/api/status`        | Full `StatusSnapshot` for the Dashboard           |
| `GET`  | `/api/device/status` | Minimal status for hardware clients               |
| `GET`  | `/api/agents/detect` | Detect local Codex / Claude CLI and hook setup    |
| `POST` | `/api/ack/:agent`    | Mark an agent's terminal result as read           |
| `POST` | `/api/mute`          | `{ "muted": true }` to silence notification sound |
| `GET`  | `/api/health`        | Liveness probe                                    |
| `WS`   | `/ws`                | Push channel: `status` + `notification` messages  |

## Data & privacy

CodePulse stores a single SQLite database in the Electron user-data directory:

| OS      | Path                                                       |
| ------- | ---------------------------------------------------------- |
| Windows | `%APPDATA%\CodePulse\codepulse.sqlite`                     |
| macOS   | `~/Library/Application Support/CodePulse/codepulse.sqlite` |
| Linux   | `~/.config/CodePulse/codepulse.sqlite`                     |

It records events, sessions, turns, and token snapshots. Prompts are stored
only as short previews, never in full. Delete the file to reset all history.

## Development

```bash
pnpm dev          # app with hot reload (electron-vite)
pnpm typecheck    # tsc across every package
pnpm test         # unit tests
pnpm smoke        # backend integration test (no Electron, no agent needed)
pnpm lint         # prettier --check
pnpm format       # prettier --write
pnpm db:generate  # generate Drizzle SQL migrations from the schema
```

Workspace packages are consumed from TypeScript **source** (each package's
`exports` points at `src/index.ts`); electron-vite and esbuild bundle the
source directly, so there is no per-package compile step during development.

### Building a distributable

```bash
pnpm build        # build packages, then bundle the app into apps/desktop/out
pnpm dist         # package an installer into apps/desktop/release
pnpm dist:dir     # unpacked build (faster, for local testing)
```

Targets are configured in `apps/desktop/electron-builder.yml` (NSIS on
Windows, DMG on macOS, AppImage on Linux). The native `better-sqlite3` addon
is kept outside the asar archive so it loads at runtime.

## Troubleshooting

<details>
<summary><b>The Dashboard never leaves "waiting for events"</b></summary>

The agent isn't reaching the server. Check that the hook paths in your
settings are absolute and correct, that CodePulse is running, and that
`curl http://127.0.0.1:17888/api/health` returns `{"ok":true}`. If you changed
the port, set `CODEPULSE_URL` for the hooks.

</details>

<details>
<summary><b>Console logs "SQLite unavailable — running without persistence"</b></summary>

The native `better-sqlite3` build doesn't match your runtime's ABI. The live
Dashboard still works; only history persistence is off. Rebuild for Electron:

```bash
# <ELECTRON_VERSION> = the version in node_modules/electron/package.json
cd node_modules/better-sqlite3
node ../.bin/prebuild-install --runtime electron --target <ELECTRON_VERSION> --arch x64
```

(`electron-builder install-app-deps` does not work under pnpm's hoisted
layout — use the command above.)

</details>

<details>
<summary><b>Port 17888 is already in use</b></summary>

Another instance (or app) holds the port. Quit the other instance from the
tray, or change the port and set `CODEPULSE_URL` for the hooks to match.

</details>

<details>
<summary><b>pnpm install didn't build better-sqlite3 / electron</b></summary>

pnpm 10 blocks dependency build scripts unless allow-listed. They are listed
under `pnpm.onlyBuiltDependencies` in the root `package.json`; run
`pnpm install` again, or `pnpm rebuild`.

</details>

## Roadmap

**v0.1 (current)** ships the full local pipeline end-to-end: event ingestion,
the unified state machine, the rule engine with throttling, SQLite
persistence, the tray, desktop notifications, the live Dashboard, and the
device status API.

Planned next (see [`requirements.md`](./requirements.md) §12):

- [ ] Settings UI & one-click hook installation
- [ ] ESP32 hardware status display client
- [ ] Precise Codex token accounting
- [ ] Cloud sync & accounts

## Contributing

Issues and pull requests are welcome. Before submitting:

1. `pnpm typecheck && pnpm test && pnpm smoke` must pass.
2. Format with `pnpm format`.
3. Keep changes focused — one concern per PR.

For product context, read [`requirements.md`](./requirements.md); the
state-machine transition table in §8 is the source of truth for lifecycle
behavior.
