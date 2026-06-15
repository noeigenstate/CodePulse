# CodePulse

A local desktop console for Codex and Claude Code.

CodePulse shows which AI coding agent is running, waiting for you, finished, or needs attention. It runs locally, lives in the tray, and sends a desktop notification when a project turn is complete.

[简体中文](./README.zh-CN.md) | [Product spec](./requirements.md) | [Releases](https://github.com/noeigenstate/CodePulse/releases)

## Features

- Tracks Claude Code and Codex side by side.
- Groups status by project instead of mixing every terminal together.
- Shows context window usage, 5-hour quota, weekly quota, and reset time when the CLI provides it.
- Sends concise desktop notifications for completed turns.
- Checks local configuration every time the app starts.
- Installs required CodePulse hooks automatically and removes them automatically on uninstall.
- Keeps all data local. The server listens on `127.0.0.1:17888`.

## Download

Download the Windows installer from:

https://github.com/noeigenstate/CodePulse/releases

Use the `.exe` file under Assets, for example:

`CodePulse_0.1.5_x64-setup.exe`

## First Run

1. Install and open CodePulse.
2. CodePulse checks your local Claude Code and Codex setup.
3. If configuration is missing, CodePulse writes only its own required hook entries to:
   - `~/.claude/settings.json`
   - `~/.codex/hooks.json`
   - `~/.codex/config.toml`
4. If Codex asks you to trust hooks, open any Codex project terminal and run:

```text
/hooks
```

5. Select the CodePulse hook and trust these events:
   - `SessionStart`
   - `UserPromptSubmit`
   - `PreToolUse`
   - `PermissionRequest`
   - `PostToolUse`
   - `Stop`
6. Run one Claude Code or Codex task. The dashboard will start syncing.

CodePulse only manages CodePulse hook and status line entries. Existing user hooks, models, plugins, and preferences are preserved.

## What It Changes Locally

CodePulse may add:

- Claude Code hook entries and status line command.
- Codex hook entries.
- `hooks = true` under Codex features when needed.

When CodePulse is uninstalled, the installer removes CodePulse-managed hook and status line entries automatically.

## Privacy

- Events stay on your machine.
- The local API binds to `127.0.0.1` only.
- Prompt text is stored only as a short preview, not the full prompt.
- History is stored in SQLite under the Electron user-data directory.

Default database paths:

- Windows: `%APPDATA%\CodePulse\codepulse.sqlite`
- macOS: `~/Library/Application Support/CodePulse/codepulse.sqlite`
- Linux: `~/.config/CodePulse/codepulse.sqlite`

## Development

Requirements:

- Node.js 20 or newer
- pnpm 9 or newer

Install and run:

```bash
pnpm install
pnpm dev
```

Checks:

```bash
pnpm typecheck
pnpm test
pnpm smoke
pnpm lint
```

Build installer:

```bash
pnpm dist
```

The Windows installer is written to:

`apps/desktop/release/`

## Release

The GitHub workflow builds and publishes a Windows installer when a `v*` tag is pushed.

```bash
git push origin main
git push origin v0.1.5
```

If you intentionally moved an existing tag:

```bash
git push --force origin v0.1.5
```

## Local API

CodePulse exposes a loopback-only API at `http://127.0.0.1:17888`.

Common endpoints:

- `GET /api/health`
- `GET /api/status`
- `GET /api/agents/detect`
- `POST /api/events`
- `WS /ws`

## License

MIT. See [LICENSE](./LICENSE).
