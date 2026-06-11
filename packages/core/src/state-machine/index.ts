/**
 * CodePulse 核心的纯 reducer。给定某 agent 的当前运行时状态与一个
 * 归一化事件，按需求 §8 的迁移表计算下一个运行时状态。
 *
 * reducer 刻意保持无副作用，因而易于单元测试，
 * 同一逻辑也可运行在任何上下文（主进程、服务器、测试）。
 *
 * @module core/state-machine
 */
import {
  type AgentEvent,
  type AgentRuntimeState,
  type AgentType,
  type TokenPayload,
  type TokenRateLimitWindow,
  TurnState,
  isTerminalState,
} from '@codepulse/shared'

/**
 * 为尚未上报过的 agent 构建初始空闲运行时状态。
 *
 * @param agentType 要创建状态槽位的 agent。
 * @returns 处于 `IDLE` 状态的全新 {@link AgentRuntimeState}。
 */
export function createInitialRuntimeState(agentType: AgentType): AgentRuntimeState {
  return {
    agentType,
    state: TurnState.IDLE,
    toolCallCount: 0,
    needPermission: false,
    needUserInput: false,
    lastEventAt: 0,
    unread: false,
  }
}

/**
 * 通过 {@link reduce} 投喂一个事件后的结果。
 */
export interface TransitionResult {
  /** Event-time runtime state before applying the reducer. */
  previous: AgentRuntimeState
  /** 应用事件后的新运行时状态。 */
  next: AgentRuntimeState
  /** 该事件是否首次把轮次带入终结状态。 */
  turnEnded: boolean
  /** 事件发生前 agent 所处的状态。 */
  previousState: TurnState
}

/**
 * 把一个事件应用到 agent 的运行时状态上。
 *
 * 纯函数：从不修改 `current`，也不产生副作用。返回的
 * {@link TransitionResult} 还会报告之前的状态以及轮次是否刚刚结束，
 * 供规则引擎决定通知。
 *
 * 公共上下文字段（会话/轮次 id、工作区、模型、token 用量）
 * 不论事件种类，只要事件携带就会被继承更新。
 *
 * @param current agent 现有的运行时状态。
 * @param event 待应用的归一化事件。
 * @returns 下一个状态及迁移元数据。
 */
export function reduce(current: AgentRuntimeState, event: AgentEvent): TransitionResult {
  const previousState = current.state
  const next: AgentRuntimeState = {
    ...current,
    lastEventAt: event.timestamp,
  }

  // 继承事件经常刷新的上下文字段。
  if (event.externalSessionId) next.externalSessionId = event.externalSessionId
  if (event.externalTurnId) next.externalTurnId = event.externalTurnId
  if (event.workspacePath ?? event.cwd) next.workspacePath = event.workspacePath ?? event.cwd
  if (event.model) next.model = event.model
  if (event.token) next.token = mergeToken(current.token, event.token)

  switch (event.eventType) {
    case 'session_start':
      next.state = TurnState.IDLE
      next.unread = false
      next.token = undefined
      break

    case 'prompt_submit':
      next.state = TurnState.PROMPT_SUBMITTED
      next.turnStartedAt = event.timestamp
      next.toolCallCount = 0
      next.needPermission = false
      next.needUserInput = false
      next.unread = false
      next.activity = 'AI 正在处理任务'
      next.lastAssistantMessage = undefined
      break

    case 'tool_start':
      next.state = TurnState.TOOL_RUNNING
      next.toolName = event.toolName
      next.toolCallCount = current.toolCallCount + 1
      next.activity = describeTool(event)
      break

    case 'tool_end':
      // 回到思考状态，直到下一个信号；保持轮次存活。
      next.state = TurnState.THINKING
      next.toolName = undefined
      next.activity = 'AI 正在生成响应'
      break

    case 'permission_request':
      next.state = TurnState.WAITING_PERMISSION
      next.needPermission = true
      next.activity = event.message ?? describeTool(event) ?? '等待用户授权'
      break

    case 'user_input_required':
      next.state = TurnState.WAITING_USER_INPUT
      next.needUserInput = true
      next.activity = event.message ?? '等待用户继续输入'
      break

    case 'turn_stop':
      next.state = TurnState.DONE
      next.turnStartedAt = undefined
      next.needPermission = false
      next.needUserInput = false
      next.toolName = undefined
      next.activity = '本轮任务已完成'
      next.unread = true
      if (event.message) next.lastAssistantMessage = event.message
      break

    case 'turn_error':
      next.state = TurnState.ERROR
      next.turnStartedAt = undefined
      next.activity = event.message ?? '任务执行出错'
      next.unread = true
      break

    case 'turn_cancelled':
      next.state = TurnState.CANCELLED
      next.turnStartedAt = undefined
      next.needPermission = false
      next.needUserInput = false
      next.toolName = undefined
      next.activity = event.message ?? '任务已取消'
      next.unread = true
      break

    case 'token_snapshot':
      // 仅携带 token 数据；不改变生命周期状态。
      break

    case 'session_end':
      next.state = TurnState.IDLE
      next.turnStartedAt = undefined
      next.needPermission = false
      next.needUserInput = false
      next.toolName = undefined
      next.activity = undefined
      next.token = undefined
      break

    default:
      assertNever(event.eventType)
  }

  return {
    previous: current,
    next,
    turnEnded: isTerminalState(next.state) && !isTerminalState(previousState),
    previousState,
  }
}

function mergeToken(current: TokenPayload | undefined, patch: TokenPayload): TokenPayload {
  const next: TokenPayload = {
    ...current,
    accuracy: patch.accuracy ?? current?.accuracy ?? 'unknown',
  }

  if (patch.input !== undefined) next.input = patch.input
  if (patch.cachedInput !== undefined) next.cachedInput = patch.cachedInput
  if (patch.output !== undefined) next.output = patch.output
  if (patch.reasoningOutput !== undefined) next.reasoningOutput = patch.reasoningOutput
  if (patch.total !== undefined) next.total = patch.total
  if (patch.contextUsedPercent !== undefined) next.contextUsedPercent = patch.contextUsedPercent
  if (patch.contextWindow !== undefined) next.contextWindow = patch.contextWindow
  if (patch.costUsd !== undefined) next.costUsd = patch.costUsd
  if (patch.rateLimits) next.rateLimits = mergeRateLimits(current?.rateLimits, patch.rateLimits)

  return next
}

function mergeRateLimits(
  current: TokenPayload['rateLimits'],
  patch: TokenPayload['rateLimits'],
): TokenPayload['rateLimits'] {
  if (!patch) return current
  return {
    fiveHour: mergeRateLimitWindow(current?.fiveHour, patch.fiveHour),
    sevenDay: mergeRateLimitWindow(current?.sevenDay, patch.sevenDay),
  }
}

function mergeRateLimitWindow(
  current: TokenRateLimitWindow | undefined,
  patch: TokenRateLimitWindow | undefined,
): TokenRateLimitWindow | undefined {
  if (!patch) return current
  return {
    ...current,
    ...(patch.usedPercent !== undefined ? { usedPercent: patch.usedPercent } : {}),
    ...(patch.resetsAt !== undefined ? { resetsAt: patch.resetsAt } : {}),
    ...(patch.windowMinutes !== undefined ? { windowMinutes: patch.windowMinutes } : {}),
  }
}

/**
 * 为事件涉及的工具生成简短的人类可读描述。
 *
 * @param event 携带工具/命令上下文的事件。
 * @returns 中文活动描述；无可描述内容时为 `undefined`。
 */
function describeTool(event: AgentEvent): string | undefined {
  if (event.command) return `正在执行 ${event.command}`
  if (event.toolName) return `正在调用 ${event.toolName}`
  return undefined
}

/**
 * 穷尽性辅助函数：若新增事件类型而未补 `case`，则触发编译期错误；
 * 运行时到达此处则抛出异常。
 *
 * @param value 已被类型系统收窄为 `never` 的值。
 * @returns 永不返回。
 */
function assertNever(value: never): never {
  throw new Error(`Unhandled event type: ${String(value)}`)
}
