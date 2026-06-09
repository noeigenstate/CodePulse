# CodePulse Desktop / 码脉桌面端需求说明

## 1. 项目概述

**CodePulse Desktop / 码脉桌面端** 是一个面向工程师的 AI 编程状态监控桌面软件，用于监控 Codex、Claude Code 等 AI Coding Agent 的运行状态、任务进度、token/context 使用情况，并在一轮任务完成、等待用户授权、等待用户输入、执行异常或疑似卡住时及时提醒工程师。

该软件的核心目标不是单纯显示 token，而是让工程师不用持续盯着 VS Code 终端，也能清楚知道 AI Agent 当前是否还在执行、是否已经完成、是否需要人工介入。

后续可以接入 ESP32 墨水屏硬件，作为桌面物理提醒终端。

---

## 2. 产品定位

### 2.1 产品名称

**CodePulse Desktop**

中文名：**码脉桌面端**

### 2.2 一句话定位

CodePulse Desktop 是一个本地 AI 编程状态中枢，通过 Codex、Claude Code 的 hooks、status、status line 等机制，监控 AI 编程任务状态，并在关键节点提醒工程师。

### 2.3 核心价值

* 不需要工程师一直盯着终端。
* 能及时知道 AI 一轮任务是否完成。
* 能及时发现 AI 是否在等待用户授权或输入。
* 能显示 token/context 使用情况，避免上下文爆掉。
* 能记录 AI 编程会话，方便后续复盘。
* 后续可以对接桌面硬件，形成软硬件一体化产品。

---

## 3. 目标用户

### 3.1 主要用户

* 使用 Codex CLI 的工程师
* 使用 Claude Code 的工程师
* 同时使用多个 AI Coding Agent 的开发者
* 高频使用 AI vibecoding 的独立开发者
* AI 编程团队中的研发人员

### 3.2 用户痛点

当前 AI Coding Agent 在终端中执行任务时，工程师常遇到以下问题：

1. 不知道 AI 是否还在执行。
2. 不知道 AI 是否已经完成一轮任务。
3. 不知道 AI 是否在等待授权或继续输入。
4. 不知道 token/context 是否接近上限。
5. 多个终端、多项目同时运行时状态混乱。
6. AI 执行完成后没有明显提醒，容易错过。
7. 工程师需要频繁切回终端查看状态，打断工作流。

---

## 4. 产品目标

### 4.1 MVP 目标

第一版产品重点解决以下问题：

* 识别 Codex / Claude Code 一轮任务的开始和结束。
* 识别 AI 是否正在执行工具调用。
* 识别 AI 是否等待用户授权。
* 识别 AI 是否等待用户继续输入。
* 在一轮任务结束时发送桌面通知。
* 在需要用户介入时发送强提醒。
* 在桌面端 Dashboard 中显示当前状态。
* 在系统托盘中显示整体运行状态。
* 为未来硬件显示端预留本地 API。

### 4.2 非目标

第一版不做以下内容：

* 不做云同步。
* 不做账号系统。
* 不做团队协作。
* 不做复杂数据图表。
* 不做 VS Code 插件。
* 不做硬件端。
* 不强求 Codex token 绝对精准实时。
* 不解析 VS Code 终端文本作为主要数据来源。

---

## 5. 核心需求

## 5.1 Agent 状态监控

系统需要监控 Codex、Claude Code 的当前运行状态。

### 状态类型

| 状态                 | 说明                       |
| ------------------ | ------------------------ |
| Idle               | 当前没有 AI 任务运行             |
| Running            | AI 正在处理任务                |
| Thinking           | AI 正在生成响应或规划             |
| Tool Running       | AI 正在调用工具，例如读文件、改文件、执行命令 |
| Waiting Permission | AI 正在等待用户授权              |
| Waiting Input      | AI 正在等待用户继续输入            |
| Done               | 当前一轮任务已完成                |
| Error              | 当前任务执行出错                 |
| Timeout            | 长时间无事件，疑似卡住              |
| Unknown            | 状态未知或数据源异常               |

---

## 5.2 一轮任务识别

系统需要将一次用户 prompt 到 AI 完成响应的过程识别为一个 **Turn**。

### 一轮任务的定义

一轮任务通常包含：

1. 用户提交 prompt。
2. AI 开始处理任务。
3. AI 调用工具，例如读取文件、修改文件、执行命令。
4. AI 可能请求用户授权。
5. AI 可能等待用户继续输入。
6. AI 输出最终结果。
7. 当前轮任务结束。

### 一轮完成的判断

系统应优先通过 hook 事件判断一轮是否完成。

* Codex 侧：优先监听 `Stop` 事件。
* Claude Code 侧：优先监听对应的 stop / completion 生命周期事件。

当系统收到一轮完成事件时，应触发：

* Dashboard 状态更新。
* 托盘状态更新。
* 桌面通知。
* 会话记录保存。
* 未来硬件状态更新。

---

## 5.3 用户介入提醒

系统需要重点识别以下场景：

### 等待授权

当 AI Agent 请求执行命令、修改文件或访问敏感资源时，可能需要用户授权。

系统应在此时触发强提醒：

* 桌面通知。
* 托盘变黄。
* 可选声音提醒。
* Dashboard 显示等待授权状态。

### 等待输入

当 AI Agent 等待用户继续输入、确认方向或补充需求时，系统应提醒用户。

### 疑似卡住

如果 AI Agent 长时间没有产生新事件，系统应进入疑似卡住状态。

建议规则：

| 条件        | 行为          |
| --------- | ----------- |
| 2 分钟无新事件  | 轻提醒         |
| 5 分钟无新事件  | 显示疑似卡住      |
| 10 分钟无新事件 | 强提醒         |
| 用户静音时     | 只更新 UI，不发声音 |

---

## 5.4 Token / Context 展示

系统需要展示 Codex、Claude Code 的 token/context 使用情况。

### Claude Code

Claude Code 可优先通过 status line 采集以下信息：

* input tokens
* output tokens
* total tokens
* context 使用百分比
* cost
* 当前模型
* 当前项目目录
* git 分支

Claude Code 的 token/context 数据可以作为较高可信度来源。

### Codex

Codex 可通过以下方式尝试采集：

* hooks 生命周期状态
* `/status` 中展示的用量信息
* `/statusline` 中的状态栏信息

第一版不强制承诺 Codex token 绝对精准实时。

Codex token 数据应标记准确性：

| 准确性       | 说明                  |
| --------- | ------------------- |
| exact     | 明确从稳定结构化数据中获得       |
| estimated | 根据 transcript 或文本估算 |
| unknown   | 当前无法获得              |

---

## 5.5 桌面 Dashboard

系统需要提供一个主界面 Dashboard，用于展示当前所有 AI Agent 的状态。

### Dashboard 需要展示

* Agent 名称
* 当前状态
* 当前项目目录
* 当前模型
* 当前一轮耗时
* 最近事件
* 是否等待用户授权
* 是否等待用户输入
* token/context 使用情况
* cost 信息
* 工具调用次数
* 最后一条 AI 消息摘要

### 示例

```text
CodePulse Desktop

Claude Code
状态：Running
项目：ai-hardware
模型：Claude Sonnet
Context：68%
当前：正在执行 npm test
耗时：3m 12s

Codex
状态：Waiting Permission
项目：dingcode
当前：请求执行 shell command
最近事件：12s ago
```

---

## 5.6 系统托盘

系统必须提供系统托盘图标。

### 托盘状态颜色

| 状态          | 颜色 |
| ----------- | -- |
| 全部空闲        | 灰色 |
| 有任务执行中      | 蓝色 |
| 等待授权 / 等待输入 | 黄色 |
| 一轮完成未读      | 绿色 |
| 执行出错        | 红色 |
| 疑似卡住        | 橙色 |

### 托盘菜单

```text
CodePulse
────────────────
Claude Code: Running
Codex: Waiting Permission
────────────────
打开面板
静音 30 分钟
清除提醒
设置
退出
```

---

## 5.7 桌面通知

系统需要提供不同级别的桌面通知。

### 通知类型

| 事件             | 通知级别      |
| -------------- | --------- |
| 一轮任务完成         | 普通提醒      |
| 需要用户授权         | 强提醒       |
| 需要继续输入         | 强提醒       |
| 执行失败           | 强提醒       |
| context 超过 80% | 轻提醒       |
| context 超过 95% | 强提醒       |
| 疑似卡住           | 轻提醒，持续后升级 |

### 防打扰规则

* 同一轮任务完成只提醒一次。
* 同一个 session 30 秒内最多响一次。
* 权限等待提醒间隔不少于 60 秒。
* 静音模式下不播放声音。
* 夜间模式默认关闭声音。
* 用户可以对某个项目单独设置通知策略。

---

## 5.8 会话记录

系统需要记录 AI 编程会话，用于回看和后续统计。

### 记录内容

| 字段             | 说明                    |
| -------------- | --------------------- |
| Agent          | Codex / Claude Code   |
| 项目目录           | 当前 workspace          |
| 模型             | 当前使用模型                |
| 开始时间           | 用户提交 prompt 时间        |
| 结束时间           | 一轮结束时间                |
| 任务状态           | 完成、失败、等待用户、卡住         |
| 耗时             | 本轮任务耗时                |
| 工具调用次数         | 文件读取、文件修改、命令执行等       |
| token/context  | 有则记录，无则 unknown       |
| cost           | 有则记录                  |
| 最后一条消息         | AI 最终回复摘要             |
| prompt preview | 用户 prompt 前若干字符或 hash |

### 隐私原则

默认不保存完整 prompt 和完整 AI 回复。

建议默认保存：

* prompt preview，限制 80～120 字。
* prompt hash。
* 最后一条 AI 消息摘要。
* 事件类型。
* 状态变化。
* 时间戳。
* 项目路径。

用户可以在设置中选择是否保存更完整的会话内容。

---

## 5.9 本地服务

桌面端应内置一个本地 HTTP 服务，用于接收 hook 事件、提供当前状态、服务未来硬件端。

默认地址：

```text
127.0.0.1:17888
```

### API 需求

#### 接收事件

```http
POST /api/events
```

用于接收 Codex / Claude Code hook 脚本发送的事件。

#### 查询当前状态

```http
GET /api/status
```

用于 Dashboard 或其他本地客户端读取当前状态。

#### 设备状态接口

```http
GET /api/device/status
```

用于未来 ESP32 墨水屏硬件读取极简状态。

### 硬件状态返回示例

```json
{
  "mainState": "waiting_permission",
  "activeAgent": "codex",
  "message": "Codex needs permission",
  "claudeContext": 68,
  "codexState": "waiting_permission",
  "updatedAt": 1780000000000
}
```

---

## 6. 数据来源设计

## 6.1 Codex 数据源

Codex 侧主要通过 hooks 采集生命周期事件。

### 重点监听事件

| Codex 事件          | 用途       |
| ----------------- | -------- |
| UserPromptSubmit  | 判断一轮开始   |
| PreToolUse        | 判断工具调用开始 |
| PermissionRequest | 判断等待用户授权 |
| PostToolUse       | 判断工具调用结束 |
| Stop              | 判断一轮完成   |

### Codex 数据定位

Codex 数据第一版重点用于：

* 判断运行状态。
* 判断一轮开始。
* 判断一轮结束。
* 判断是否等待授权。
* 判断是否正在执行工具。

Codex token/context 数据第一版作为增强功能，不作为核心承诺。

---

## 6.2 Claude Code 数据源

Claude Code 侧通过 hooks 和 status line 组合采集。

### Hooks 用途

* 判断一轮开始。
* 判断一轮结束。
* 判断工具调用。
* 判断等待用户输入。
* 判断异常状态。

### Status Line 用途

* 采集 context 使用情况。
* 采集 token 数据。
* 采集 cost。
* 采集当前模型。
* 采集当前项目目录。
* 采集 git 分支。

---

## 7. 数据模型

## 7.1 Agent

表示一个 AI Coding Agent。

```ts
type Agent = {
  id: string
  type: "codex" | "claude_code"
  name: string
  installed: boolean
  configured: boolean
  version?: string
  lastSeenAt?: number
}
```

---

## 7.2 Workspace

表示一个项目目录。

```ts
type Workspace = {
  id: string
  name: string
  path: string
  gitBranch?: string
  lastActiveAt: number
}
```

---

## 7.3 Session

表示一次 AI Agent 会话。

```ts
type Session = {
  id: string
  agentType: "codex" | "claude_code"
  externalSessionId: string
  workspaceId: string
  model?: string
  state: "idle" | "running" | "waiting" | "done" | "error"
  startedAt: number
  endedAt?: number
}
```

---

## 7.4 Turn

表示一轮用户 prompt 到 AI 完成的过程。

```ts
type Turn = {
  id: string
  sessionId: string
  externalTurnId?: string
  state: TurnState
  promptPreview?: string
  startedAt: number
  endedAt?: number
  toolCallCount: number
  needPermission: boolean
  needUserInput: boolean
  lastAssistantMessage?: string
}
```

---

## 7.5 TokenSnapshot

表示某一刻的 token/context 状态。

```ts
type TokenSnapshot = {
  id: string
  sessionId: string
  turnId?: string
  agentType: "codex" | "claude_code"
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  contextUsedPercent?: number
  costUsd?: number
  accuracy: "exact" | "estimated" | "unknown"
  capturedAt: number
}
```

---

## 7.6 AgentEvent

系统内部统一事件格式。

```ts
type AgentEvent = {
  id: string
  source: "codex" | "claude_code"
  eventType:
    | "session_start"
    | "prompt_submit"
    | "tool_start"
    | "tool_end"
    | "permission_request"
    | "user_input_required"
    | "turn_stop"
    | "turn_error"
    | "token_snapshot"
    | "session_end"

  externalSessionId?: string
  externalTurnId?: string
  workspacePath?: string
  cwd?: string
  model?: string
  toolName?: string
  command?: string
  message?: string

  token?: {
    input?: number
    output?: number
    total?: number
    contextUsedPercent?: number
    costUsd?: number
    accuracy: "exact" | "estimated" | "unknown"
  }

  raw?: unknown
  timestamp: number
}
```

---

## 8. 状态机设计

系统需要将不同来源的事件转换为统一状态。

```text
IDLE
  ↓
PROMPT_SUBMITTED
  ↓
THINKING
  ↓
TOOL_RUNNING
  ↓
WAITING_PERMISSION
  ↓
WAITING_USER_INPUT
  ↓
DONE / ERROR / TIMEOUT / CANCELLED
```

### 状态说明

| 状态                 | 说明           |
| ------------------ | ------------ |
| IDLE               | 当前无任务        |
| PROMPT_SUBMITTED   | 用户已提交 prompt |
| THINKING           | AI 正在生成或规划   |
| TOOL_RUNNING       | AI 正在执行工具    |
| WAITING_PERMISSION | AI 等待用户授权    |
| WAITING_USER_INPUT | AI 等待用户继续输入  |
| DONE               | 当前轮任务完成      |
| ERROR              | 当前轮任务异常      |
| TIMEOUT            | 长时间无事件       |
| CANCELLED          | 用户主动中断       |

---

## 9. 设置需求

设置页需要包含以下内容。

### 通用设置

* 开机自启
* 本地服务端口
* 数据保留天数
* 是否保存 prompt preview
* 是否保存完整事件 raw data
* 语言设置
* 主题设置

### Codex 设置

* 检测 Codex 是否安装
* 检测 Codex hook 是否启用
* 安装 / 更新 Codex hook
* 测试 Codex hook
* 打开 Codex hook 配置文件

### Claude Code 设置

* 检测 Claude Code 是否安装
* 检测 Claude Code hook 是否启用
* 安装 / 更新 Claude Code hook
* 安装 / 更新 status line collector
* 测试 Claude Code hook

### 通知设置

* 一轮完成提醒开关
* 等待授权提醒开关
* 等待输入提醒开关
* 错误提醒开关
* context 阈值提醒
* 静音时间
* 夜间勿扰
* 声音开关

### 硬件设置

* 是否启用硬件接口
* 设备状态 API
* ESP32 设备配对
* 墨水屏显示模板
* RGB 灯状态映射
* 蜂鸣器提醒策略

---

## 10. 技术栈建议

## 10.1 推荐技术栈

第一版推荐使用：

```text
Electron + TypeScript + React + Vite + Fastify + WebSocket + SQLite + Drizzle ORM + Tailwind CSS + shadcn/ui
```

### 技术栈拆分

| 模块      | 技术               |
| ------- | ---------------- |
| 桌面框架    | Electron         |
| 编程语言    | TypeScript       |
| 前端框架    | React            |
| 构建工具    | Vite             |
| UI 样式   | Tailwind CSS     |
| UI 组件   | shadcn/ui        |
| 本地服务    | Fastify          |
| 实时通信    | WebSocket        |
| 数据库     | SQLite           |
| ORM     | Drizzle ORM      |
| 状态管理    | Zustand          |
| 打包      | electron-builder |
| hook 脚本 | Node.js          |

---

## 10.2 推荐 Electron 的原因

本项目需要大量本地能力：

* 系统托盘
* 桌面通知
* 本地 HTTP 服务
* WebSocket 实时通信
* 读写配置文件
* 启动本地 hook collector
* SQLite 本地数据库
* 跨平台打包
* 未来支持硬件接口

Electron 对这些能力支持成熟，适合快速完成 MVP。

---

## 10.3 暂不推荐 Tauri 的原因

Tauri 更轻量，但第一版不建议优先使用，原因是：

* 本项目不是纯 UI 桌面软件。
* 需要本地服务和大量 Node.js 生态能力。
* hook 脚本用 Node.js 更方便。
* Electron 更适合快速验证产品逻辑。
* 后期产品稳定后，可以考虑 Tauri 重构。

---

## 11. 推荐工程结构

```text
codepulse-desktop/
├── apps/
│   └── desktop/
│       ├── electron-main/
│       ├── renderer/
│       └── preload/
│
├── packages/
│   ├── core/
│   │   ├── state-machine/
│   │   ├── event-normalizer/
│   │   └── rule-engine/
│   │
│   ├── adapters/
│   │   ├── codex/
│   │   └── claude-code/
│   │
│   ├── local-server/
│   │   ├── routes/
│   │   └── websocket/
│   │
│   ├── storage/
│   │   ├── sqlite/
│   │   └── migrations/
│   │
│   ├── hooks/
│   │   ├── codex-hook.js
│   │   ├── claude-hook.js
│   │   └── claude-statusline.js
│   │
│   └── shared/
│       └── types/
│
└── package.json
```

建议采用：

```text
pnpm workspace
```

---

## 12. MVP 范围

## 12.1 V0.1 必做

* Codex hooks 接入
* Claude Code hooks 接入
* 一轮开始 / 结束识别
* 等待授权识别
* 等待输入识别
* Dashboard 当前状态展示
* 系统托盘状态
* 桌面通知
* SQLite 本地记录
* 本地 API：`/api/events`
* 本地 API：`/api/status`
* 本地 API：`/api/device/status`

---

## 12.2 V0.1 不做

* 不做云端账号
* 不做团队功能
* 不做复杂统计图表
* 不做 VS Code 插件
* 不做硬件端
* 不做移动端
* 不强求 Codex token 精准统计
* 不保存完整 prompt
* 不解析终端文本作为主数据源

---

## 13. 后续版本规划

## V0.2：Token / Context 增强版

* Claude Code context 精准展示
* Claude Code cost 展示
* Claude Code token 展示
* Codex token 尝试采集
* context 超限提醒
* 每轮任务耗时统计

## V0.3：工程师体验增强版

* 会话 Timeline
* 项目级通知策略
* 静音模式
* 夜间勿扰
* 疑似卡住提醒
* 错误记录
* 会话搜索

## V0.4：硬件桥接版

* ESP32 设备状态 API
* 局域网设备发现
* 硬件配对
* 墨水屏显示模板
* RGB 灯状态协议
* 蜂鸣器提醒策略

## V1.0：产品化版本

* 自动安装 / 修复 hooks
* 多 Agent 支持
* AI 编程日报
* 项目维度统计
* 数据导出
* 团队版基础能力
* 插件系统

---

## 14. 成功标准

MVP 成功标准如下：

1. 用户运行 Codex 或 Claude Code 时，CodePulse 能识别任务开始。
2. AI 执行工具时，CodePulse 能显示执行中状态。
3. AI 等待授权时，CodePulse 能及时提醒。
4. 一轮任务完成时，CodePulse 能及时发送桌面通知。
5. 用户可以在 Dashboard 中看到当前 Agent 状态。
6. 用户可以通过托盘图标快速判断当前 AI 状态。
7. CodePulse 没启动时，不影响 Codex / Claude Code 正常运行。
8. 所有状态事件都能保存到 SQLite。
9. `/api/device/status` 可以返回硬件端可用的简化状态。
10. 整体体验比反复盯着 VS Code 终端更高效。

---

## 15. 项目总结

CodePulse Desktop 的核心不是 token 统计，而是 AI 编程过程的状态感知。

它要解决的是：

```text
AI 现在是否在工作？
AI 是否已经完成？
AI 是否在等我？
AI 是否卡住了？
AI 是否快把上下文用完了？
```

第一版应优先做成一个稳定的本地桌面状态中枢。
后续再接入 ESP32 墨水屏、RGB 灯、蜂鸣器等硬件外设，把软件状态变成桌面上的物理提醒。

最终产品形态可以从一个桌面软件，逐步演进为：

```text
AI Coding Agent 状态中枢 + 桌面硬件提醒终端
```

这是一条非常清晰、可落地、也有商业想象力的产品路线。
