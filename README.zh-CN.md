# CodePulse Desktop / 码脉桌面端

CodePulse 是一个本地 AI 编程代理状态中心，用来同时观察 Codex 和 Claude Code 的任务状态、通知、上下文/token 使用情况，以及托盘状态。

它通过各 agent 的 hook / status-line 机制接收事件，然后在本地服务中归一化为统一状态机。CodePulse 不需要云端账号，服务默认只监听 `127.0.0.1:17888`。

## 功能概览

- 同时显示 Claude Code 和 Codex 的任务状态。
- 托盘图标展示总体状态：空闲、运行中、等待授权/输入、完成未读、错误、疑似卡住。
- 桌面通知：完成、授权、输入、错误、上下文过高、长时间无响应。
- Dashboard 展示项目、模型、本轮耗时、工具调用、当前活动、最后回复摘要。
- Claude Code 可通过 status line 上报准确的 context 使用百分比。
- Codex 可通过 hook payload 上报 `usage` / `context_used_percent`；如果 Codex payload 没有这些字段，Codex token 区域会为空。

## 环境要求

- Node.js 20 或更高版本。
- pnpm 9 或更高版本。
- Windows 上如需编译 `better-sqlite3`，需要 Visual Studio C++ Build Tools。

## 安装与启动

```bash
pnpm install
pnpm dev
```

启动后会出现：

- 系统托盘图标。
- Dashboard 窗口。
- 本地 HTTP/WebSocket 服务：`http://127.0.0.1:17888`。

关闭窗口不会退出应用；需要从托盘菜单退出。

## 配置 Claude Code

hook 脚本位于 `packages/hooks/bin/`，无额外依赖。它们会把事件 POST 到本地服务，并且无论发送是否成功都会退出 0，不会阻塞 Claude Code。

把下面内容合并到 `~/.claude/settings.json`，并把 `<REPO>` 替换为本仓库绝对路径：

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

Windows 路径需要双反斜杠，例如：

```text
node E:\\proj\\codepulse\\packages\\hooks\\bin\\claude-hook.js
```

Claude 的 status line 会转发模型、工作区、成本和 context window 数据。新版 Claude Code 会提供官方 `context_window.used_percentage`，CodePulse 会优先使用它。

## 配置 Codex

Codex 也需要配置 lifecycle hooks。没有 hook 时，CodePulse 只能显示默认的 Codex 空闲卡片和本地 CLI 检测，无法收到 Codex 的任务状态变化。

推荐使用用户级配置文件 `~/.codex/hooks.json`。把下面内容写入该文件，并把 `<REPO>` 替换为本仓库绝对路径：

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

当前 Codex hooks 默认启用。如果你曾关闭过 hooks，在 `~/.codex/config.toml` 中恢复：

```toml
[features]
hooks = true
```

添加或修改 Codex hook 后，进入 Codex 运行：

```text
/hooks
```

按提示审核并信任 command hook。Codex 会按 hook 定义记录信任状态，路径或命令改变后可能需要重新审核。

Windows 路径同样需要双反斜杠：

```text
node E:\\proj\\codepulse\\packages\\hooks\\bin\\codex-hook.js
```

## 验证配置

启动 CodePulse 后运行 Claude Code 或 Codex 的一次任务，Dashboard 和托盘应出现状态变化。

也可以用 curl 发送合成事件：

```bash
curl -X POST http://127.0.0.1:17888/api/events \
  -H "content-type: application/json" \
  -d '{"source":"claude_code","hook_event_name":"UserPromptSubmit","session_id":"demo","cwd":"/tmp/demo","prompt":"hello"}'

curl http://127.0.0.1:17888/api/status
```

后端冒烟测试：

```bash
pnpm smoke
```

## 本地 API

| 方法 | 路径                 | 用途                                     |
| ---- | -------------------- | ---------------------------------------- |
| POST | `/api/events`        | 接收 hook payload                        |
| GET  | `/api/status`        | Dashboard 完整状态                       |
| GET  | `/api/device/status` | 设备端精简状态                           |
| GET  | `/api/agents/detect` | 检测本地 Codex / Claude CLI 和 hook 配置 |
| POST | `/api/ack/:agent`    | 标记某个 agent 的终结结果为已读          |
| POST | `/api/mute`          | 设置通知静音                             |
| GET  | `/api/health`        | 健康检查                                 |
| WS   | `/ws`                | 状态和通知推送                           |

`:agent` 可取 `codex` 或 `claude_code`。如果本地服务端口改变，需要给 hook 设置同样的 `CODEPULSE_URL`。

## 数据位置

SQLite 数据库位于 Electron user-data 目录：

- Windows：`%APPDATA%\CodePulse\codepulse.sqlite`
- macOS：`~/Library/Application Support/CodePulse/codepulse.sqlite`
- Linux：`~/.config/CodePulse/codepulse.sqlite`

CodePulse 会记录事件、会话、轮次和 token 快照。提示词只保存短预览，不保存完整内容。

## 开发命令

```bash
pnpm dev
pnpm smoke
pnpm typecheck
pnpm build
pnpm lint
pnpm format
```
