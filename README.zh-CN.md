<div align="center">

# CodePulse / 码脉

**面向 AI 编程代理的本地状态中心。**

一眼看清 Codex、Claude Code 与 Grok 正在工作、在等你、已完成，还是卡住了——
无需切回终端反复确认。

[![status](https://img.shields.io/badge/status-v0.1%20MVP-orange)](#功能特性)
[![platform](https://img.shields.io/badge/platform-Windows-blue)](#下载)
[![release](https://github.com/noeigenstate/CodePulse/actions/workflows/release.yml/badge.svg)](https://github.com/noeigenstate/CodePulse/actions/workflows/release.yml)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](#开发)
[![pnpm](https://img.shields.io/badge/pnpm-%E2%89%A59-F69220?logo=pnpm&logoColor=white)](#开发)
[![built with](https://img.shields.io/badge/built%20with-Electron%20%2B%20TypeScript-47848F?logo=electron&logoColor=white)](#工作原理)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

[English](./README.md) · [简体中文](./README.zh-CN.md) · [产品需求](./requirements.md)

</div>

---

AI 编程代理很擅长无人值守地干活，却不擅长在需要你时通知你。CodePulse
监听 Codex、Claude Code 与 Grok Build 已经暴露的生命周期 hook，把每一个事件
送进同一个状态机，再用三种方式把结果呈现出来：

- 📊 **实时 Dashboard** —— 自适应分屏（只用到的 CLI 才出栏），按 agent、
  按工作区展示状态、模型、本轮耗时、上下文用量与配额。
- 🎨 **彩色托盘图标** —— 所有 agent 的总体状态，随时可见。
- 🔔 **桌面通知** —— 一轮任务完成时发送简洁的项目级提醒，内置节流与去重。

一切都在 **本地** 运行。服务只绑定回环地址，提示词仅保存短预览（绝不保存全文），
且 CodePulse 未运行时 hook 会静默失败——你的 agent 永远不会被阻塞或拖慢。

## 软件截图

![CodePulse 仪表盘](./docs/screenshots/dashboard-zh.png)

实时 Dashboard 一眼呈现每个 agent 与工作区——状态、模型、本轮耗时、上下文用量，
以及滚动的 5 小时 / 每周额度，全部实时更新。_（图为示意数据。）_

## 功能特性

|                           |                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| 🚦 **统一状态机**         | 所有 agent 共用一套轮次生命周期：空闲 → 处理中 → 执行工具 → 等待授权/输入 → 完成 / 出错 / 取消 / 卡住。 |
| 🧭 **多 agent、多工作区** | 跨项目并发的 Codex、Claude Code 与 Grok 会话，各自独立追踪。                                            |
| 🪟 **自适应分屏**         | 仅在对应 CLI 有任务（或仍保留额度）时显示分栏；只用一个 CLI 时只显示一栏，三个都用则三栏。              |
| 📈 **上下文追踪**         | 展示 Claude、Codex 与 Grok 的紧凑上下文窗口信息，优先使用 CLI 提供的精确数据。                          |
| 🎟️ **配额感知**           | 在 CLI 提供数据时，按配额桶展示 5 小时 / 每周的额度窗口，并与你实际运行的模型匹配。                     |
| 🕰️ **卡住检测**           | 看门狗会标记长时间无活动的轮次，让静默失败不再白白浪费时间。                                            |
| 💾 **本地历史**           | 事件、会话、轮次与 token 快照持久化到 SQLite——数据归你所有，可查可删。                                  |
| 🔌 **开放本地 API**       | `127.0.0.1:17888` 上的纯 HTTP + WebSocket，可用于本地集成。                                             |

## 工作原理

```
 Codex / Claude Code / Grok
   │  生命周期 hook 与 status line（零依赖 Node 脚本）
   ▼
 POST /api/events ──► 适配器 ──► StatusHub（纯 reducer + 规则引擎）
 （Fastify，回环）     归一化         │
                                     ├─► SQLite（事件 / 会话 / 轮次 / token）
                                     ├─► 托盘图标更新
                                     ├─► 桌面通知
                                     └─► WebSocket / IPC 推送 ──► Dashboard（React）
```

仓库是一个 `pnpm` workspace：

```
apps/desktop/        Electron 应用（main / preload / renderer）
packages/
  shared/            领域类型（Agent、Turn、AgentEvent…）与常量
  core/              状态机、规则引擎、聚合、StatusHub
  adapters/          Codex / Claude / Grok 原始 payload → AgentEvent 映射
  storage/           SQLite schema（Drizzle ORM）与仓储
  local-server/      Fastify HTTP + WebSocket 路由
  hooks/             agent 调用的独立 hook 脚本
scripts/             后端冒烟测试
tests/               单元测试
```

**技术栈：** Electron · electron-vite · TypeScript · React · Tailwind · Zustand ·
Fastify · better-sqlite3 · Drizzle ORM。

## 下载

从 [GitHub Releases](https://github.com/noeigenstate/CodePulse/releases)
下载 Windows 安装包，然后直接运行 Assets 里的 `.exe` 文件。

## 首次运行

1. 打开 CodePulse。
2. CodePulse 会检查本机 Claude Code、Codex 和 Grok CLI 配置。
3. 如果缺少必要项，CodePulse 只会把自己的 hook 与 status line 配置写入：
   - `~/.claude/settings.json`
   - `~/.codex/hooks.json`
   - `~/.codex/config.toml`
   - `~/.grok/hooks/codepulse.json`（Grok 全局 hooks，默认受信任）
4. 如果配置弹窗提示需要信任 Codex hook，打开一个 Codex 项目终端，运行 `/hooks`，
   选择 CodePulse hook，并信任：
   - `SessionStart`
   - `UserPromptSubmit`
   - `PreToolUse`
   - `PermissionRequest`
   - `PostToolUse`
   - `Stop`
5. 运行一轮 Claude Code、Codex 或 Grok 任务。Dashboard 只显示有活动的 CLI
   对应分屏（自适应布局）。

CodePulse 只管理 CodePulse 自己的 hook 和 status line 配置。你原有的 hook、模型、
插件和偏好设置会保留。卸载时，安装器会自动删除 CodePulse 管理的配置。

### 验证

在 Claude Code、Codex 或 Grok 中跑一次任务，观察对应分屏亮起；也可以检查本地 API：

```bash
curl http://127.0.0.1:17888/api/health
curl http://127.0.0.1:17888/api/status
```

## 托盘状态

| 颜色  | 含义                       |
| ----- | -------------------------- |
| ⚪ 灰 | 全部空闲                   |
| 🔵 蓝 | 有任务正在运行             |
| 🟡 黄 | 等待授权或输入——需要你介入 |
| 🟢 绿 | 一轮任务已完成、未读       |
| 🔴 红 | 出错                       |
| 🟠 橙 | 疑似卡住                   |

通知经过节流与去重，确保你被告知、而不是被骚扰。**静音**（托盘或顶栏按钮）会让
声音静默 30 分钟；通知仍会出现，只是没有声音。
Claude Code 常规的“waiting for your input”空闲提醒会被忽略；黄色状态只表示
CodePulse 确认看到了真实授权请求或明确输入请求。

## 本地 API

仅回环（`127.0.0.1:17888`）——绝不暴露到网络。用环境变量 `CODEPULSE_URL` 可让 hook
指向其他地址。

| 方法   | 路径                 | 用途                                       |
| ------ | -------------------- | ------------------------------------------ |
| `POST` | `/api/events`        | 接收原始 hook payload（或数组，最多 1000） |
| `GET`  | `/api/status`        | Dashboard 使用的完整 `StatusSnapshot`      |
| `GET`  | `/api/device/status` | 轻量本地客户端使用的精简状态               |
| `GET`  | `/api/agents/detect` | 检测本地 Codex / Claude / Grok CLI 与 hook |
| `POST` | `/api/ack/:agent`    | 把某个 agent 的终结结果标记为已读          |
| `POST` | `/api/mute`          | `{ "muted": true }` 静音通知声音           |
| `GET`  | `/api/health`        | 存活探针                                   |
| `WS`   | `/ws`                | 推送通道：`status` + `notification` 消息   |

## 数据与隐私

CodePulse 把单个 SQLite 数据库存放在 Electron 的 user-data 目录：

| 操作系统 | 路径                                                       |
| -------- | ---------------------------------------------------------- |
| Windows  | `%APPDATA%\CodePulse\codepulse.sqlite`                     |
| macOS    | `~/Library/Application Support/CodePulse/codepulse.sqlite` |
| Linux    | `~/.config/CodePulse/codepulse.sqlite`                     |

它记录事件、会话、轮次与 token 快照。30 天前的原始事件与 token 快照会自动清理。
提示词只保存短预览，绝不保存全文。删除该文件即可重置全部历史。

## 开发

环境要求：

- **Node.js ≥ 20**（在 22.x 上测试）
- **pnpm ≥ 9** —— `npm i -g pnpm`

```bash
pnpm install
pnpm dev          # 带热重载的应用（electron-vite）
pnpm typecheck    # 对每个包运行 tsc
pnpm test         # 单元测试
pnpm smoke        # 后端集成测试（无需 Electron、无需 agent）
pnpm lint         # prettier --check
pnpm format       # prettier --write
pnpm db:generate  # 从 schema 生成 Drizzle SQL 迁移
```

workspace 内的包以 TypeScript **源码** 形式被消费（每个包的 `exports` 指向
`src/index.ts`）；electron-vite 与 esbuild 直接打包源码，因此开发期没有逐包编译步骤。

### 构建可分发版本

```bash
pnpm build        # 构建各包，再把应用打包进 apps/desktop/out
pnpm dist         # 把安装包打到 apps/desktop/release
pnpm dist:dir     # 免安装目录（更快，便于本地测试）
```

`pnpm dist` 使用 `package.json` 与 `apps/desktop/package.json` 里的版本号；
发版前必须让它们与 tag 一致。推送 tag 前，请新增或更新
`docs/release-notes/vX.Y.Z.md`，GitHub Release 会直接使用该文件作为发版说明。
如果用户可见行为发生变化，请在同一次改动里同步更新英文 README 和本中文版。

打包目标在 `apps/desktop/electron-builder.yml` 中配置（Windows 用 NSIS、macOS 用 DMG、
Linux 用 AppImage）。原生模块 `better-sqlite3` 会保留在 asar 归档之外，以便运行时加载；
非运行时源码和未使用的 Electron 语言资源会从安装包中排除。

### 发版流程

仓库只保留一个 GitHub Actions workflow：`Build and Release CodePulse`。

它会在推送 `v*` tag 或从 GitHub Actions 手动运行时触发。流程会安装依赖，执行
`typecheck`、`test`、`smoke`、`lint`，构建 Windows 安装包，上传 `.exe` / `.blockmap` /
`latest.yml`，并创建或更新 GitHub Release。

发版说明来自 `docs/release-notes/vX.Y.Z.md`。内容保持简短、面向用户：只写这版更新了什么，
不要写内部实现流水账。

发布一个版本：

```bash
pnpm typecheck && pnpm test && pnpm smoke && pnpm lint
git tag vX.Y.Z
git push origin main vX.Y.Z
```

## 故障排查

<details>
<summary><b>Dashboard 一直停在“正在等待事件”</b></summary>

说明 agent 没有触达服务。请检查 CodePulse 正在运行、
`curl http://127.0.0.1:17888/api/health` 返回 `{"ok":true}`，并且配置弹窗没有提示
Claude / Codex / Grok hook 缺失。Codex 如果提示需要信任，请运行一次 `/hooks` 并信任
CodePulse hook。Grok 全局 hooks 写在 `~/.grok/hooks/codepulse.json`，无需项目级信任。

</details>

<details>
<summary><b>控制台输出“SQLite unavailable — running without persistence”</b></summary>

原生 `better-sqlite3` 的构建与运行时 ABI 不匹配。实时 Dashboard 仍可用，只是关闭了历史
持久化。为 Electron 重新构建：

```bash
# <ELECTRON_VERSION> = node_modules/electron/package.json 中的版本号
cd node_modules/better-sqlite3
node ../.bin/prebuild-install --runtime electron --target <ELECTRON_VERSION> --arch x64
```

（在 pnpm 的提升式布局下 `electron-builder install-app-deps` 不起作用——请用上面的命令。）

</details>

<details>
<summary><b>端口 17888 已被占用</b></summary>

另一个实例（或应用）占用了该端口。从托盘退出另一个实例，或改用其他端口并给 hook 设置
对应的 `CODEPULSE_URL`。

</details>

<details>
<summary><b>pnpm install 没有构建 better-sqlite3 / electron</b></summary>

pnpm 10 默认会拦截依赖的构建脚本，除非加入允许清单。它们已列在根 `package.json` 的
`pnpm.onlyBuiltDependencies` 下；重新运行 `pnpm install`，或执行 `pnpm rebuild`。

</details>

## 贡献

欢迎提交 issue 与 pull request。提交前请确保：

1. `pnpm typecheck && pnpm test && pnpm smoke` 全部通过。
2. 用 `pnpm format` 格式化。
3. 保持改动聚焦——一个 PR 只做一件事。

产品背景请阅读 [`requirements.md`](./requirements.md)；其中 §8 的状态机迁移表是生命周期
行为的权威依据。

## 许可证

基于 [MIT 许可证](./LICENSE) 发布 © 2026 CodePulse Contributors。
