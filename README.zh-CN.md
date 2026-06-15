# CodePulse / 码脉

面向 Codex 和 Claude Code 的本地桌面状态面板。

CodePulse 用来快速看清 AI 编程代理当前是在执行、等待你确认、已经完成，还是需要处理。软件常驻托盘，本地运行，并在项目的一轮任务完成时发送桌面提醒。

[English](./README.md) | [产品需求](./requirements.md) | [下载发布版](https://github.com/noeigenstate/CodePulse/releases)

## 功能

- 同时显示 Claude Code 和 Codex。
- 按项目分组显示状态，不把所有终端混在一起。
- 在 CLI 提供数据时显示上下文窗口、5 小时额度、每周额度和刷新时间。
- 一轮任务完成时发送简洁桌面通知。
- 每次启动自动检查本机配置。
- 自动写入 CodePulse 所需 hook，卸载时自动清理。
- 数据只保存在本机，本地服务只监听 `127.0.0.1:17888`。

## 下载

从 GitHub Releases 下载 Windows 安装包：

https://github.com/noeigenstate/CodePulse/releases

下载 Assets 里的 `.exe` 文件，例如：

`CodePulse_0.1.5_x64-setup.exe`

## 首次使用

1. 安装并打开 CodePulse。
2. CodePulse 会检查本机 Claude Code 和 Codex 配置。
3. 如果缺少配置，CodePulse 只会写入自己需要的 hook 配置：
   - `~/.claude/settings.json`
   - `~/.codex/hooks.json`
   - `~/.codex/config.toml`
4. 如果 Codex 提示需要信任 hook，打开任意正在使用的 Codex 项目终端，输入：

```text
/hooks
```

5. 在 `/hooks` 列表中选择 CodePulse hook，并信任这些事件：
   - `SessionStart`
   - `UserPromptSubmit`
   - `PreToolUse`
   - `PermissionRequest`
   - `PostToolUse`
   - `Stop`
6. 运行一轮 Claude Code 或 Codex 任务，面板就会开始同步。

CodePulse 只管理 CodePulse 自己的 hook 和 status line 配置。你原有的 hook、模型、插件和偏好设置会保留。

## 会改动哪些本地配置

CodePulse 可能会添加：

- Claude Code hook 和 status line 命令。
- Codex hook 命令。
- 必要时在 Codex features 中启用 `hooks = true`。

卸载 CodePulse 时，安装器会自动删除 CodePulse 管理的 hook 和 status line 配置。

## 隐私

- 事件数据只留在本机。
- 本地 API 只绑定 `127.0.0.1`。
- 提示词只保存短预览，不保存完整内容。
- 历史数据保存在 Electron 用户数据目录下的 SQLite 数据库。

默认数据库位置：

- Windows：`%APPDATA%\CodePulse\codepulse.sqlite`
- macOS：`~/Library/Application Support/CodePulse/codepulse.sqlite`
- Linux：`~/.config/CodePulse/codepulse.sqlite`

## 开发

要求：

- Node.js 20 或更新版本
- pnpm 9 或更新版本

安装并运行：

```bash
pnpm install
pnpm dev
```

检查：

```bash
pnpm typecheck
pnpm test
pnpm smoke
pnpm lint
```

生成安装包：

```bash
pnpm dist
```

Windows 安装包会生成到：

`apps/desktop/release/`

## 发布

推送 `v*` 标签时，GitHub workflow 会自动构建并发布 Windows 安装包。

```bash
git push origin main
git push origin v0.1.5
```

如果你是有意移动已有标签：

```bash
git push --force origin v0.1.5
```

## 本地 API

CodePulse 在 `http://127.0.0.1:17888` 提供本地 API。

常用接口：

- `GET /api/health`
- `GET /api/status`
- `GET /api/agents/detect`
- `POST /api/events`
- `WS /ws`

## 许可证

MIT，见 [LICENSE](./LICENSE)。
