<div align="center">

# CodePulse / 码脉

\*_面向 AI 编程代理的本地状态中心�?_

一眼看�?Codex、Claude Code �?Grok 正在工作、在等你、已完成，还是卡住了—�?无需切回终端反复确认�?
[![status](https://img.shields.io/badge/status-v1.2.0-brightgreen)](#功能特�?
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](#下载)
[![release](https://github.com/noeigenstate/CodePulse/actions/workflows/release.yml/badge.svg)](https://github.com/noeigenstate/CodePulse/actions/workflows/release.yml)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](#开�?
[![pnpm](https://img.shields.io/badge/pnpm-%E2%89%A59-F69220?logo=pnpm&logoColor=white)](#开�?
[![built with](https://img.shields.io/badge/built%20with-Electron%20%2B%20TypeScript-47848F?logo=electron&logoColor=white)](#工作原理)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

[English](./README.md) · [简体中文](./README.zh-CN.md) · [产品需求](./requirements.md)

</div>

---

AI 编程代理很擅长无人值守地干活，却不擅长在需要你时通知你。CodePulse
监听 Codex、Claude Code �?Grok Build 已经暴露的生命周�?hook，把每一个事�?送进同一个状态机，再用三种方式把结果呈现出来�?

- 📊 **实时 Dashboard** —�?浅色自适应分屏（Claude Code / Codex / Grok�? 只用到的 CLI 才出栏），品牌色面板、项目卡片、上下文与额度进度一目了然�?- 📈 **本地统计后台** —�?右上角「后台」进入全屏分析：Token、时长、项目排行�? 模型占比与高峰时段，全部从本�?SQLite 汇总，可随时刷新同步�?- 🎨 **彩色托盘图标** —�?所�?agent 的总体状态，随时可见�?- 🔔 **桌面通知** —�?完成时以项目名为标题，正文为用户提问摘要
  （中�?�?5 �?/ 英文 �?5 词），内置节流与去重�?
  一切都�?**本地** 运行。服务只绑定回环地址；SQLite 只保留统计所需的结构化字段�?最�?120 字符的文本预览，完整 Hook、工具输�?输出、环境变量和命令参数不会落盘�?CodePulse 未运行时 hook 会静默失败——你�?agent 永远不会被阻塞或拖慢�?

## 软件截图

### 实时控制�?

<p align="center">
  <img src="./docs/screenshots/dashboard-zh.png" alt="CodePulse 实时控制�? width="920" />
</p>

三栏自适应控制台：Claude 显示 **5 小时 + 每周** 额度；Codex / Grok 仅显�?**每周额度**�?项目卡片包含模型、耗时、上下文窗口与状态徽标。右上角 \*_「后台�?_ 可进入本地统计。_（图为示意数据。）_

### 本地统计后台

<p align="center">
  <img src="./docs/screenshots/stats-zh.png" alt="CodePulse 本地统计后台" width="920" />
</p>

从本�?SQLite 汇�?Token、开发时长、项目排行、模型占比与高峰时段；支持今�?/ �?7 �?/ �?30 天与按日 / �?/ 月趋势，数据不上传云端。_（图为示意数据。）_

## 功能特�?

|                          |                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| 🚦 **统一状态机**        | 所�?agent 共用一套轮次生命周期：空闲 �?处理�?�?执行工具 �?等待授权/输入 �?完成 / 出错 / 取消 / 卡住�? |
| 🧭 \*_�?agent、多工作�?_ | 跨项目并发的 Codex、Claude Code �?Grok 会话，各自独立追踪�?                                           |
| 🪟 **自适应分屏**        | 仅在对应 CLI 有任务（或仍保留额度）时显示分栏；只用一�?CLI 时只显示一栏，三个都用则三栏�?             |
| 🎨 **浅色设计系统**      | 品牌色分屏�?px 进度条、状态徽标，以及分屏/会话同步信息的底部状态栏�?                                  |
| 📈 \*_上下文追�?_        | 展示 Claude、Codex �?Grok 的紧凑上下文窗口信息，优先使�?CLI 提供的精确数据�?                          |
| 🎟�?**配额感知**         | Claude�? 小时 + 每周；Codex / Grok：仅每周额度，并�?CLI 上报的模�?配额桶匹配�?                        |
| 🔔 **一眼可读的通知**    | 完成标题为项目名；正文为清洗后的提问摘要，不夹带 CLI 品牌文案�?                                       |
| 🕰�?\*_卡住检�?_         | 看门狗会标记长时间无活动的轮次，让静默失败不再白白浪费时间�?                                          |
| 💾 **本地历史**          | 事件、会话、轮次与 token 快照持久化到 SQLite——数据归你所有，可查可删�?                                |
| 📊 **本地统计后台**      | �?SQLite 汇�?Token / 开发时�?/ 项目 / 对话；支持今日、近 7 天、近 30 天与按日/�?月趋势�?              |
| 🔌 **开放本�?API**       | `127.0.0.1:17888` 上的�?HTTP + WebSocket，可用于本地集成�?                                            |

## 本地统计后台

实时 Dashboard 回答「现在谁在跑」；**本地统计后台** 回答「这段时间花了多少资源」�?

1. 在实时控制台右上角点�?**「后台�?\*（英文界面为 **Insights**）�?2. 全屏打开统计台，数据来自本机 `codepulse.sqlite`（经应用�?IPC 聚合�?*不上传云�?*）�?3. 选择 **今日 / �?7 �?/ �?30 �?_，需要时�?\*\*「刷新数据�?_ 重新汇总最新事件�?4. 趋势图可切换 **按日 / 按周 / 按月**。按 `Esc` �?**「退出大屏�?\* 返回实时控制台�?
   后台主要模块�?
   | 模块 | 说明 |
   | ---------------- | --------------------------------------------------------------------- |
   | **概览 KPI** | 总消�?Token、�?日均开发时长、项目数、对话次数，并给出与上期的环比�?|
   | **趋势** | Token 消耗与开发时长曲线，便于发现峰值日�? |
   | **模型占比** | 各模型用量份额（�?Claude / GPT / Gemini 等）�? |
   | **高峰时段** | 按星�?× 小时的热力图，看清活跃集中时段�? |
   | **项目消耗排�?_ | 按项目汇�?Token、时长、对话次数与最近活跃时间�? |
   | **使用洞察** | 基于本地汇总的轻量提示（峰值日、主力模型、效率建议等）�? |
   | \*\*分布与评�?_ | 项目类型、文件类型（尽力而为）、单次对�?Token 分桶、本地效率评分�? |

> �?CLI 任务并成功写入本地库后，后台才会逐步填满；全新安装或刚清理历史时会提示暂无数据�?
> Grok 执行中的上下文占用会优先读活动会话的 `updates.jsonl`，任务结束后�?`signals.json` 为准�?

## 工作原理

````
 Codex / Claude Code / Grok
   �? 生命周期 hook �?status line（零依赖 Node 脚本�?   �? POST /api/events ──�?适配�?──�?StatusHub（纯 reducer + 规则引擎�? （Fastify，回环）     归一�?        �?                                     ├─�?SQLite（事�?/ 会话 / 轮次 / token / 工作区）
                                     ├─�?托盘图标更新
                                     ├─�?桌面通知
                                     └─�?WebSocket / IPC 推�?──�?Dashboard（React�?                                                              └─�?统计后台（SQLite 聚合�?```

仓库是一�?`pnpm` workspace�?
````

apps/desktop/ Electron 应用（main / preload / renderer，含统计后台 UI�?packages/
shared/ 领域类型（Agent、Turn、AgentEvent、UsageStats…）与常�? core/ 状态机、规则引擎、聚合、StatusHub
adapters/ Codex / Claude / Grok 原始 payload �?AgentEvent 映射
storage/ SQLite schema（Drizzle ORM）、仓储与用量统计查询
local-server/ Fastify HTTP + WebSocket 路由
hooks/ agent 调用的独�?hook 脚本（含 Grok/Codex 用量读取�?scripts/ 后端冒烟测试
tests/ 单元测试

````

**技术栈�?* Electron · electron-vite · TypeScript · React · Tailwind · Zustand ·
Fastify · better-sqlite3 · Drizzle ORM�?
## 下载

�?[GitHub Releases](https://github.com/noeigenstate/CodePulse/releases)
下载安装包：

- **Windows�?* `CodePulse_*_x64-setup.exe`
- **macOS Apple Silicon�?* `CodePulse_*_mac-arm64.dmg`（M 系列芯片�?- **macOS Intel�?* `CodePulse_*_mac-x64.dmg`

### macOS 首次打开（未签名构建�?
当前 Release 中的 macOS 安装�?*未做 Apple 代码签名与公�?*。用浏览器（�?Chrome�?下载后，系统会加上隔离标记。双击时可能弹出�?
> “CodePulse�?is damaged and can’t be opened. You should move it to the Trash.
> （“CodePulse”已损坏，无法打开。你应该将它移到废纸篓。）

�?*通常不是安装包真的损�?*，而是 Gatekeeper 对未签名 + 隔离 App 的拦截文案�?「系统设�?�?隐私与安全�?�?仍要打开」对这种 **damaged** 提示**往往无效**�?
**推荐做法（终端）�?*

1. 打开 DMG，把 `CodePulse.app` 拖到「应用程序」�?2. 打开「终端」，执行（路径按实际安装位置调整）：

```bash
xattr -cr /Applications/CodePulse.app
open /Applications/CodePulse.app
````

�?App 还在 DMG 卷上，可先对挂载路径执行，例如：

```bash
xattr -cr /Volumes/CodePulse*/CodePulse.app
```

3. 之后可从启动台或「应用程序」正常打开�?
   请按本机芯片选择对应 DMG（arm64 / Intel），架构不对也会打不开�?

### macOS 检测不�?Claude / Codex / Grok 命令�?

从「启动台 / Finder」打开�?App **不会加载** 终端里的 `~/.zshrc` PATH�?
CLI 若装�?Homebrew（`/opt/homebrew/bin`）或 nvm/npm 全局目录，旧版可能误报「未检测到命令行工具」�?
当前版本会自动探测常见安装路径。若仍检测失败，可在终端确认 CLI 可用�?

```bash
which claude codex grok
claude --version
codex --version
grok --version
```

也可设置绝对路径后重�?CodePulse�?

```bash
launchctl setenv CLAUDE_CLI_PATH "$(which claude)"
launchctl setenv CODEX_CLI_PATH "$(which codex)"
launchctl setenv GROK_CLI_PATH "$(which grok)"
```

（或在启�?CodePulse �?shell �?`export` 上述变量后再 `open -a CodePulse`。）

## 首次运行

1. 打开 CodePulse�?2. CodePulse 会检查本�?Claude Code、Codex �?Grok CLI 配置�?3. 如果缺少必要项，CodePulse 只会把自己的 hook �?status line 配置写入�? - `~/.claude/settings.json`
   - `~/.codex/hooks.json`
   - `~/.codex/config.toml`
   - `~/.grok/hooks/codepulse.json`（Grok 全局 hooks，默认受信任�?4. 如果配置弹窗提示需要信�?Codex hook，打开一�?Codex 项目终端，运�?`/hooks`�? 选择 CodePulse hook，并信任�? - `SessionStart`
   - `UserPromptSubmit`
   - `PreToolUse`
   - `PermissionRequest`
   - `PostToolUse`
   - `Stop`
2. 运行一�?Claude Code、Codex �?Grok 任务。Dashboard 只显示有活动�?CLI
   对应分屏（自适应布局）�?6. 需要复盘消耗时，点右上�?\*_「后台�?_ 打开本地统计台（详见
   [本地统计后台](#本地统计后台)）�?
   CodePulse 只管�?CodePulse 自己�?hook �?status line 配置。你原有�?hook、模型�?插件和偏好设置会保留。卸载时，安装器会自动删�?CodePulse 管理的配置�?

### 验证

�?Claude Code、Codex �?Grok 中跑一次任务，观察对应分屏亮起；也可以检查本�?API�?

```bash
curl http://127.0.0.1:17888/api/health
curl http://127.0.0.1:17888/api/status
```

## 托盘状�?

| 颜色  | 含义                       |
| ----- | -------------------------- |
| �?�?  | 全部空闲                   |
| 🔵 �? | 有任务正在运�?             |
| 🟡 �? | 等待授权或输入——需要你介入 |
| 🟢 �? | 一轮任务已完成、未�?       |
| 🔴 �? | 出错                       |
| 🟠 �? | 疑似卡住                   |

通知经过节流与去重，确保你被告知、而不是被骚扰。完成时标题�?`{emoji} {项目} 已完成`，正文为用户提问摘要（中�?�?5 字，英文 �?5 词）�?**静音**（托盘或顶栏按钮）会让声音静�?30 分钟；通知仍会出现，只是没有声音�?Claude Code 常规的“waiting for your input”空闲提醒会被忽略；黄色状态只表示
CodePulse 确认看到了真实授权请求或明确输入请求�?

## 本地 API

仅回环（`127.0.0.1:17888`）——绝不暴露到网络。用环境变量 `CODEPULSE_URL` 可让 hook
指向其他地址�?
| 方法 | 路径 | 用�? |
| ------ | -------------------- | ------------------------------------------ |
| `POST` | `/api/events` | 接收原始 hook payload（或数组，最�?1000�?|
| `GET` | `/api/status` | Dashboard 使用的完�?`StatusSnapshot` |
| `GET` | `/api/device/status` | 轻量本地客户端使用的精简状�? |
| `GET` | `/api/agents/detect` | 检测本�?Codex / Claude / Grok CLI �?hook |
| `POST` | `/api/ack/:agent` | 把某�?agent 的终结结果标记为已读 |
| `POST` | `/api/mute` | `{ "muted": true }` 静音通知声音 |
| `GET` | `/api/health` | 存活探针 |
| `WS` | `/ws` | 推送通道：`status` + `notification` 消息 |

## 数据与隐�?

CodePulse 把单�?SQLite 数据库存放在 Electron �?user-data 目录�?
| 操作系统 | 路径 |
| -------- | ---------------------------------------------------------- |
| Windows | `%APPDATA%\CodePulse\codepulse.sqlite` |
| macOS | `~/Library/Application Support/CodePulse/codepulse.sqlite` |
| Linux | `~/.config/CodePulse/codepulse.sqlite` |

它记录事件、会话、轮次、工作区�?token 快照。事件只包含结构化元数据、派生文件类型和
最�?120 字符的用�?助手文本预览；完�?Hook、完整命令、工具输�?输出与环境变量不会写�?SQLite。升级时会自动清理旧版本曾保存的原始 Hook 和完整命令�?0 天前的事件与 token 快照
会自动清理；删除该文件即可重置全部历史�?
**本地统计后台** 只在本机读取上述数据库做聚合展示，不会把用量或项目路径上传到任何服务器�?

## 开�?

环境要求�?

- **Node.js �?20**（在 22.x 上测试）
- **pnpm �?9** —�?`npm i -g pnpm`

```bash
pnpm install
pnpm dev          # 带热重载的应用（electron-vite�?pnpm typecheck    # 对每个包运行 tsc
pnpm test         # 单元测试
pnpm smoke        # 后端集成测试（无需 Electron、无需 agent�?pnpm lint         # prettier --check
pnpm format       # prettier --write
pnpm db:generate  # �?schema 生成 Drizzle SQL 迁移
```

workspace 内的包以 TypeScript **源码** 形式被消费（每个包的 `exports` 指向
`src/index.ts`）；electron-vite �?esbuild 直接打包源码，因此开发期没有逐包编译步骤�?

### 构建可分发版�?

```bash
pnpm build        # 构建各包，再把应用打包进 apps/desktop/out
pnpm dist         # 为当前操作系统打包安装包�?apps/desktop/release
pnpm dist:win     # Windows NSIS 安装包（.exe�?pnpm dist:mac     # macOS DMG：分别打 arm64 �?Intel x64（非 universal�?pnpm dist:mac:arm64
pnpm dist:mac:x64
pnpm dist:dir     # 免安装目录（更快，便于本地测试）
```

`pnpm dist` / `dist:win` / `dist:mac` 使用 `package.json` �?`apps/desktop/package.json` 里的版本号；发版前必须让它们�?tag 一致。推�?tag 前，
请新增或更新 `docs/release-notes/vX.Y.Z.md`，GitHub Release 会直接使用该文件作为发版说明�?如果用户可见行为发生变化，请在同一次改动里同步更新英文 README 和本中文版�?
打包目标�?`apps/desktop/electron-builder.yml` 中配置（Windows �?NSIS、macOS �?Intel/Apple Silicon 双架�?DMG、Linux �?AppImage）。原生模�?`better-sqlite3`
会保留在 asar 归档之外，以便运行时加载；非运行时源码和未使用的 Electron 语言资源会从
安装包中排除�?
macOS CI 产物�?\*未签名、未公证\*\*构建。用户侧请按上文
[macOS 首次打开](#macos-首次打开未签名构�? �?`xattr -cr` 去除隔离标记�?「隐私与安全�?�?仍要打开」对 “is damaged�?类弹窗通常无效�?

### 发版流程

仓库只保留一�?GitHub Actions workflow：`Build and Release CodePulse`�?
它会在推�?`v*` tag 或从 GitHub Actions 手动运行时触发。流程会**并行**构建
Windows �?macOS 安装包，并在各平台任务中执行 `typecheck` / `test` / `smoke` /
`lint`，最后汇总上�?`.exe`、`.dmg`、blockmap 与发版说明，创建或更�?GitHub Release�?
发版说明来自 `docs/release-notes/vX.Y.Z.md`。内容保持简短、面向用户：只写这版更新了什么，
不要写内部实现流水账�?
发布一个版本：

```bash
pnpm typecheck && pnpm test && pnpm smoke && pnpm lint
git tag vX.Y.Z
git push origin main vX.Y.Z
```

## 故障排查

<details>
<summary><b>macOS 提示 “CodePulse is damaged and can’t be opened�?/b></summary>

安装包一般没有损坏。当�?mac 构建未签名，下载后的隔离标记会触发该文案�?请按 [macOS 首次打开](#macos-首次打开未签名构�? 执行�?

```bash
xattr -cr /Applications/CodePulse.app
open /Applications/CodePulse.app
```

「系统设�?�?隐私与安全�?�?仍要打开」对这种弹窗通常无效。请确认下载的是
与本机芯片匹配的 DMG（`mac-arm64` / `mac-x64`）�?

</details>

<details>
<summary><b>Dashboard 一直停在“正在等待事件�?/b></summary>

说明 agent 没有触达服务。请检�?CodePulse 正在运行�?`curl http://127.0.0.1:17888/api/health` 返回 `{"ok":true}`，并且配置弹窗没有提�?Claude / Codex / Grok hook 缺失。Codex 如果提示需要信任，请运行一�?`/hooks` 并信�?CodePulse hook。Grok 全局 hooks 写在 `~/.grok/hooks/codepulse.json`，无需项目级信任�?

</details>

<details>
<summary><b>控制台输出“SQLite unavailable �?running without persistence�?/b></summary>

原生 `better-sqlite3` 的构建与运行�?ABI 不匹配。实�?Dashboard 仍可用，只是关闭了历�?持久化。为 Electron 重新构建�?

```bash
# <ELECTRON_VERSION> = node_modules/electron/package.json 中的版本�?cd node_modules/better-sqlite3
node ../.bin/prebuild-install --runtime electron --target <ELECTRON_VERSION> --arch x64
```

（在 pnpm 的提升式布局�?`electron-builder install-app-deps` 不起作用——请用上面的命令。）

</details>

<details>
<summary><b>端口 17888 已被占用</b></summary>

另一个实例（或应用）占用了该端口。从托盘退出另一个实例，或改用其他端口并�?hook 设置
对应�?`CODEPULSE_URL`�?

</details>

<details>
<summary><b>pnpm install 没有构建 better-sqlite3 / electron</b></summary>

pnpm 10 默认会拦截依赖的构建脚本，除非加入允许清单。它们已列在�?`package.json` �?`pnpm.onlyBuiltDependencies` 下；重新运行 `pnpm install`，或执行 `pnpm rebuild`�?

</details>

## 贡献

欢迎提交 issue �?pull request。提交前请确保：

1. `pnpm typecheck && pnpm test && pnpm smoke` 全部通过�?2. �?`pnpm format` 格式化�?3. 保持改动聚焦——一�?PR 只做一件事�?
   产品背景请阅�?[`requirements.md`](./requirements.md)；其�?§8 的状态机迁移表是生命周期
   行为的权威依据�?

## 许可�?

基于 [MIT 许可证](./LICENSE) 发布 © 2026 CodePulse Contributors�?
