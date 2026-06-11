# CodePulse Desktop / 码脉桌面端

中文文档：[README.zh-CN.md](./README.zh-CN.md)

A local AI coding-agent **status hub**. CodePulse watches Codex and Claude Code
through their hook / status-line mechanisms and tells you — without staring at a
terminal — whether the agent is still working, has finished a turn, is waiting
for your permission/input, errored, or looks stuck. See
[`requirements.md`](./requirements.md) for the full product spec.

This repository contains the **V0.1 MVP**: a runnable Electron app with the local
server, state machine, rule engine, SQLite storage, system tray, desktop
notifications, a live Dashboard, and the Codex / Claude Code hook scripts.

---

## Table of contents

- [What it does](#what-it-does)
- [Stack](#stack)
- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [How to use the software](#how-to-use-the-software)
  - [1. Install](#1-install)
  - [2. Launch](#2-launch)
  - [3. Connect Claude Code](#3-connect-claude-code)
  - [4. Connect Codex](#4-connect-codex)
  - [5. Verify it works](#5-verify-it-works)
  - [6. Read the Dashboard](#6-read-the-dashboard)
  - [7. Use the tray](#7-use-the-tray)
  - [8. Notifications & quiet rules](#8-notifications--quiet-rules)
- [Where your data lives](#where-your-data-lives)
- [Local API reference](#local-api-reference)
- [Building a distributable](#building-a-distributable)
- [Developing](#developing)
- [Troubleshooting](#troubleshooting)
- [V0.1 status](#v01-status)

---

## What it does

CodePulse answers, at a glance, the questions you normally have to switch back to
the terminal for:

> Is the AI still working? Has it finished? Is it waiting on me? Is it stuck? Is
> it about to run out of context?

It does this by receiving lifecycle events from each agent's hooks, running them
through a single state machine, and surfacing the result three ways: a **live
Dashboard**, a **colour-coded tray icon**, and **desktop notifications** that
fire only when something actually needs you.

## Stack

`Electron + electron-vite + TypeScript + React + Vite + Tailwind + Zustand`
on the front, `Fastify + @fastify/websocket + better-sqlite3 + Drizzle ORM` on
the back — all in a `pnpm` workspace.

## Repository layout

```
apps/desktop/            Electron app (main / preload / renderer)
packages/
  shared/                Domain types (Agent, Turn, AgentEvent, …) + constants
  core/                  State machine, rule engine, aggregation, StatusHub
  adapters/              Codex / Claude raw-payload → AgentEvent mapping
  storage/               SQLite schema (Drizzle) + repository
  local-server/          Fastify HTTP + WebSocket (/api/events, /api/status, …)
  hooks/                 Standalone hook scripts agents invoke
scripts/                 Backend smoke test (`pnpm smoke`)
```

Data flow: **hook script → `POST /api/events` → adapter normalizes → `StatusHub`
(reducer + rule engine) → { SQLite persist, tray update, desktop notification,
WebSocket / IPC push → Dashboard }**.

## Prerequisites

- **Node.js ≥ 20** (tested on 22.x)
- **pnpm ≥ 9** (`npm i -g pnpm`)
- **A C++ build toolchain** for the native `better-sqlite3` module. On Windows
  that means the **Visual Studio C++ Build Tools**; CodePulse fetches a prebuilt
  binary when possible, so you usually do not need to compile anything. See
  [Troubleshooting](#troubleshooting) if the database fails to load.

---

## How to use the software

### 1. Install

```bash
pnpm install
```

This installs all workspace dependencies and builds the native modules. The root
`package.json` allow-lists `better-sqlite3`, `electron`, and `esbuild` for build
scripts (pnpm 10 blocks these by default).

### 2. Launch

```bash
pnpm dev
```

On launch you get:

- a **CodePulse icon in the system tray** (grey = idle),
- the **Dashboard window**, and
- a **local server** on `http://127.0.0.1:17888` that the hooks talk to.

> CodePulse lives in the tray: closing the window keeps it running in the
> background. Quit it from the tray menu → **退出 (Quit)**.

Until you connect an agent (next steps), the Dashboard shows
“正在等待 Codex / Claude Code 事件…”. **CodePulse not running does not affect your
agents** — the hooks fail silently when the server is down.

### 3. Connect Claude Code

The hook scripts live in `packages/hooks/bin/` and are dependency-free; they POST
to the local server and **exit 0 no matter what**, so they never block or break
the agent. Replace `<REPO>` below with the absolute path to this repository.

Add this to **`~/.claude/settings.json`** (merge with anything already there):

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

- The **hooks** report lifecycle events (start, tool use, permission, stop, …).
- The **status line** both forwards token/context/cost data **and** prints a
  compact line for Claude to display (e.g. `⏺ Claude Sonnet · my-project · ctx 68%`).

> On Windows, use double backslashes in the path, e.g.
> `node E:\\proj\\codepulse\\packages\\hooks\\bin\\claude-hook.js`.

### 4. Connect Codex

Yes. Codex also needs lifecycle hooks configured. Without hooks, CodePulse can
only show the default idle Codex slot and local CLI detection; it will not
receive Codex task state changes.

Codex discovers hooks next to active config layers. The simplest user-level
setup is **`~/.codex/hooks.json`**. Replace `<REPO>` with the absolute path to
this repository:

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

Codex hooks are enabled by default in current Codex builds. If you previously
disabled them, re-enable them in **`~/.codex/config.toml`**:

```toml
[features]
hooks = true
```

After adding or changing a Codex hook, open Codex and run `/hooks` to review and
trust the command hook. Codex records trust against the hook definition; changed
paths or commands may need review again.

> On Windows, use double backslashes in the path, e.g.
> `node E:\\proj\\codepulse\\packages\\hooks\\bin\\codex-hook.js`.

> Codex does not currently have a CodePulse status-line collector like Claude.
> Token/context usage is shown when the Codex hook payload includes `usage` /
> `context_used_percent`; otherwise the Codex token section remains empty.

> The Codex adapter maps the event names in requirements §6.1 and reads field
> names defensively, so adjust the hook payload keys if your Codex build differs.

### 5. Verify it works

Run a task in Claude Code or Codex and watch the Dashboard and tray light up.

To verify **without** an agent, send a synthetic event with `curl` (or
PowerShell) and refresh the Dashboard:

```bash
# A Claude "prompt submitted" event
curl -X POST http://127.0.0.1:17888/api/events \
  -H "content-type: application/json" \
  -d '{"source":"claude_code","hook_event_name":"UserPromptSubmit","session_id":"demo","cwd":"/tmp/demo","prompt":"hello"}'

# Read current status
curl http://127.0.0.1:17888/api/status
```

You can also run the bundled backend integration test, which exercises the whole
pipeline (no Electron, no agent required):

```bash
pnpm smoke
```

### 6. Read the Dashboard

Each agent gets a card showing:

| Field                     | Meaning                                                                   |
| ------------------------- | ------------------------------------------------------------------------- |
| **State badge**           | Idle / 处理中 / 执行工具 / 等待授权 / 等待输入 / 已完成 / 出错 / 疑似卡住 |
| **项目 (Project)**        | Final segment of the workspace path                                       |
| **模型 (Model)**          | Model in use (from Claude's status line)                                  |
| **本轮耗时 (Elapsed)**    | Time since the current turn started (live)                                |
| **工具调用 (Tool calls)** | Tool-call count in the current turn                                       |
| **当前 (Activity)**       | What the agent is doing right now, e.g. `正在执行 npm test`               |
| **Context bar**           | Context-window usage — blue, yellow ≥80%, red ≥95% — plus cost            |
| **Last message**          | Summary of the AI's final reply                                           |
| **标记已读**              | Acknowledge a finished/errored result (clears the tray badge)             |

The right-hand rail lists recent **notifications**, colour-coded by severity and
individually dismissible.

### 7. Use the tray

The tray icon colour is the **overall** state across all agents:

| Colour    | Meaning                                     |
| --------- | ------------------------------------------- |
| ⚪ Grey   | All idle                                    |
| 🔵 Blue   | A task is running                           |
| 🟡 Yellow | Waiting for permission or input — needs you |
| 🟢 Green  | A turn finished, unread                     |
| 🔴 Red    | An error                                    |
| 🟠 Orange | Suspected stuck                             |

The tray menu shows each agent's current state and offers: **打开面板 (Open)**,
**静音 30 分钟 (Mute 30 min)**, **清除提醒 (Clear alerts)**, **设置 (Settings)**,
and **退出 (Quit)**.

### 8. Notifications & quiet rules

Notifications come in three levels:

| Level      | Sound | When                                                |
| ---------- | ----- | --------------------------------------------------- |
| **strong** | yes   | Needs permission, needs input, error, context ≥ 95% |
| **normal** | yes   | A turn completed                                    |
| **soft**   | no    | Context ≥ 80%; first signs of being stuck           |

To avoid nagging, the rule engine throttles repeats: at most one notification per
agent every **30 s**, permission reminders no more than once every **60 s**, and
stuck alerts escalate at **2 / 5 / 10 minutes** of inactivity. Context warnings
fire once per threshold crossing and reset after a compaction.

**Mute** (from the tray or the header button) silences sound for **30 minutes**;
notifications still appear, just without sound.

---

## Where your data lives

CodePulse stores its SQLite database in the Electron user-data directory:

- **Windows:** `%APPDATA%\CodePulse\codepulse.sqlite`
- **macOS:** `~/Library/Application Support/CodePulse/codepulse.sqlite`
- **Linux:** `~/.config/CodePulse/codepulse.sqlite`

It records events, sessions, turns, and token snapshots. Following the spec's
privacy principle (§5.8), prompts are stored only as short previews, never in
full. Delete the file to reset all history.

## Local API reference

The server binds to loopback only (`127.0.0.1:17888`), so it is never exposed to
the network.

| Method | Path                 | Purpose                                           |
| ------ | -------------------- | ------------------------------------------------- |
| POST   | `/api/events`        | Ingest a raw hook payload (or an array of them)   |
| GET    | `/api/status`        | Full `StatusSnapshot` for the Dashboard           |
| GET    | `/api/device/status` | Minimal status for the future ESP32 hardware end  |
| GET    | `/api/agents/detect` | Detect local Codex / Claude CLI and hook setup    |
| POST   | `/api/ack/:agent`    | Mark an agent's terminal result as read           |
| POST   | `/api/mute`          | `{ "muted": true }` to silence notification sound |
| GET    | `/api/health`        | Liveness probe                                    |
| WS     | `/ws`                | Push channel: `status` + `notification` messages  |

`:agent` is `codex` or `claude_code`. Override the server URL the hooks target
with the `CODEPULSE_URL` environment variable.

## Building a distributable

```bash
pnpm build        # type-build packages, then bundle the app into apps/desktop/out
pnpm dist         # package an installer into apps/desktop/release
pnpm dist:dir     # unpacked build (faster, for local testing)
```

Targets are configured in `apps/desktop/electron-builder.yml` (NSIS on Windows,
DMG on macOS, AppImage on Linux). The native `better-sqlite3` addon is kept
unpacked from the asar archive so it can be loaded at runtime.

## Developing

```bash
pnpm dev          # app with hot reload (electron-vite)
pnpm typecheck    # tsc across every package
pnpm smoke        # backend integration test (no Electron)
pnpm lint         # prettier --check
pnpm format       # prettier --write
pnpm db:generate  # generate Drizzle SQL migrations from the schema
```

Workspace packages are consumed from TypeScript **source** (each package's
`exports` points at `src/index.ts`); electron-vite and esbuild bundle the source
directly, so there is no separate per-package compile step.

## Troubleshooting

**The Dashboard never leaves “正在等待…”.**
The agent isn't reaching the server. Check that the hook paths in your settings
are absolute and correct, that `pnpm dev` is running, and that
`curl http://127.0.0.1:17888/api/health` returns `{"ok":true}`. If you changed
the port, set `CODEPULSE_URL` for the hooks.

**Console logs “SQLite unavailable — running without persistence”.**
The native `better-sqlite3` build doesn't match your runtime's ABI. The live
Dashboard still works; only history persistence is off. Rebuild it for Electron:

```bash
# from the repo root, with <ELECTRON_VERSION> = the version in node_modules/electron/package.json
cd node_modules/better-sqlite3
node ../.bin/prebuild-install --runtime electron --target <ELECTRON_VERSION> --arch x64
```

(`electron-builder install-app-deps` does not work under pnpm's hoisted layout —
use the command above.)

**Port 17888 is already in use.**
Another instance (or app) holds the port. Quit the other instance from the tray,
or change the port (and set `CODEPULSE_URL` for the hooks to match).

**pnpm install didn't build `better-sqlite3` / `electron`.**
pnpm 10 blocks dependency build scripts unless allow-listed. They are listed
under `pnpm.onlyBuiltDependencies` in the root `package.json`; run
`pnpm install` again, or `pnpm rebuild`.

## V0.1 status

Implemented end-to-end: event ingestion, the unified state machine, the stuck /
context / permission rule engine with throttling, SQLite persistence (events +
sessions + turns + token snapshots), the tray with colour states + menu, desktop
notifications, the live Dashboard, and `/api/device/status`.

Intentionally deferred (per spec §12.2): cloud sync, accounts, a Settings UI,
auto hook installation, the ESP32 hardware client, and precise Codex token
accounting.
