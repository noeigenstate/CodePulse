/**
 * 全系统共享的统一轮次/agent 状态机。来自 Codex 与 Claude Code 的事件
 * 被归一化为这些状态之间的迁移（需求 §8）。
 *
 * @module shared/types/state
 */

/**
 * 枚举一个轮次（一次「提示 → 回复」循环）可能处于的所有状态。
 *
 * 实现为冻结对象加同名类型，使得这些值既可在运行时引用
 * （如 `TurnState.DONE`），又可在类型位置作为字符串字面量联合使用。
 */
export const TurnState = {
  /** 没有 AI 任务在运行。 */
  IDLE: 'IDLE',
  /** 用户提交了提示词，轮次已开始。 */
  PROMPT_SUBMITTED: 'PROMPT_SUBMITTED',
  /** AI 正在生成回复或进行规划。 */
  THINKING: 'THINKING',
  /** AI 正在执行工具（读/改文件、运行命令等）。 */
  TOOL_RUNNING: 'TOOL_RUNNING',
  /** AI 正在等待用户批准某个操作。 */
  WAITING_PERMISSION: 'WAITING_PERMISSION',
  /** AI 正在等待用户继续/澄清。 */
  WAITING_USER_INPUT: 'WAITING_USER_INPUT',
  /** 当前轮次成功完成。 */
  DONE: 'DONE',
  /** 当前轮次以错误告终。 */
  ERROR: 'ERROR',
  /** 长时间无新事件 —— 疑似卡住。 */
  TIMEOUT: 'TIMEOUT',
  /** 用户取消了该轮次。 */
  CANCELLED: 'CANCELLED',
} as const

/** 由所有 {@link TurnState} 值组成的字符串字面量联合。 */
export type TurnState = (typeof TurnState)[keyof typeof TurnState]

/** 轮次仍处于活动中的状态（非终结结果）。 */
export const ACTIVE_STATES: readonly TurnState[] = [
  TurnState.PROMPT_SUBMITTED,
  TurnState.THINKING,
  TurnState.TOOL_RUNNING,
  TurnState.WAITING_PERMISSION,
  TurnState.WAITING_USER_INPUT,
]

/** 终结状态 —— 轮次到达其中之一即结束。 */
export const TERMINAL_STATES: readonly TurnState[] = [
  TurnState.DONE,
  TurnState.ERROR,
  TurnState.TIMEOUT,
  TurnState.CANCELLED,
]

/**
 * 判断轮次是否仍在进行中。
 *
 * @param state 待测试的状态。
 * @returns 若 `state` 属于 {@link ACTIVE_STATES} 则为 `true`。
 */
export function isActiveState(state: TurnState): boolean {
  return ACTIVE_STATES.includes(state)
}

/**
 * 判断轮次是否已到达终结结果。
 *
 * @param state 待测试的状态。
 * @returns 若 `state` 属于 {@link TERMINAL_STATES} 则为 `true`。
 */
export function isTerminalState(state: TurnState): boolean {
  return TERMINAL_STATES.includes(state)
}

/**
 * 判断某状态是否需要用户介入。
 *
 * 驱动托盘的「attention」颜色与强提醒通知。
 *
 * @param state 待测试的状态。
 * @returns 对 `WAITING_PERMISSION` 或 `WAITING_USER_INPUT` 返回 `true`。
 */
export function needsUserAttention(state: TurnState): boolean {
  return state === TurnState.WAITING_PERMISSION || state === TurnState.WAITING_USER_INPUT
}
