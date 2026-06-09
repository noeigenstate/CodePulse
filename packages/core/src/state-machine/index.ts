/**
 * The pure reducer at the heart of CodePulse. Given an agent's current runtime
 * state and one normalized event, it computes the next runtime state, following
 * the transition table in requirements §8.
 *
 * The reducer is deliberately side-effect-free so it is trivial to unit-test and
 * so the same logic can run in any context (main process, server, tests).
 *
 * @module core/state-machine
 */
import {
  type AgentEvent,
  type AgentRuntimeState,
  type AgentType,
  TurnState,
  isTerminalState,
} from '@codepulse/shared'

/**
 * Builds the initial idle runtime state for an agent that has not reported yet.
 *
 * @param agentType The agent to create a state slot for.
 * @returns A fresh {@link AgentRuntimeState} in the `IDLE` state.
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
 * The outcome of feeding one event through {@link reduce}.
 */
export interface TransitionResult {
  /** The new runtime state after applying the event. */
  next: AgentRuntimeState
  /** Whether this event moved the turn into a terminal state for the first time. */
  turnEnded: boolean
  /** The state the agent was in before the event. */
  previousState: TurnState
}

/**
 * Applies one event to an agent's runtime state.
 *
 * Pure function: it never mutates `current` and produces no side effects. The
 * returned {@link TransitionResult} also reports the previous state and whether
 * the turn just ended, which the rule engine uses to decide notifications.
 *
 * Common context fields (session/turn ids, workspace, model, token usage) are
 * carried forward from the event when present, regardless of event kind.
 *
 * @param current The agent's existing runtime state.
 * @param event The normalized event to apply.
 * @returns The next state plus transition metadata.
 */
export function reduce(current: AgentRuntimeState, event: AgentEvent): TransitionResult {
  const previousState = current.state
  const next: AgentRuntimeState = {
    ...current,
    lastEventAt: event.timestamp,
  }

  // Carry forward context that events commonly refresh.
  if (event.externalSessionId) next.externalSessionId = event.externalSessionId
  if (event.externalTurnId) next.externalTurnId = event.externalTurnId
  if (event.workspacePath ?? event.cwd) next.workspacePath = event.workspacePath ?? event.cwd
  if (event.model) next.model = event.model
  if (event.token) next.token = event.token

  switch (event.eventType) {
    case 'session_start':
      next.state = TurnState.IDLE
      next.unread = false
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
      // Back to thinking until the next signal; keep the turn alive.
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

    case 'token_snapshot':
      // Token data only; do not alter the lifecycle state.
      break

    case 'session_end':
      next.state = TurnState.IDLE
      next.turnStartedAt = undefined
      next.needPermission = false
      next.needUserInput = false
      next.toolName = undefined
      next.activity = undefined
      break

    default:
      assertNever(event.eventType)
  }

  return { next, turnEnded: isTerminalState(next.state) && !isTerminalState(previousState), previousState }
}

/**
 * Produces a short, human-readable description of the tool an event refers to.
 *
 * @param event The event carrying tool/command context.
 * @returns A Chinese activity string, or `undefined` if nothing to describe.
 */
function describeTool(event: AgentEvent): string | undefined {
  if (event.command) return `正在执行 ${event.command}`
  if (event.toolName) return `正在调用 ${event.toolName}`
  return undefined
}

/**
 * Exhaustiveness helper: forces a compile-time error if a new event type is
 * added without a corresponding `case`, and throws if reached at runtime.
 *
 * @param value A value the type system has narrowed to `never`.
 * @returns Never returns.
 */
function assertNever(value: never): never {
  throw new Error(`Unhandled event type: ${String(value)}`)
}
