import { TurnState } from '../types/state.js'
import type { UiLocale } from '../types/runtime.js'

/** Shared user-facing vocabulary; lifecycle codes and visual levels stay unchanged. */
export const WORK_STATE_LABELS: Record<UiLocale, Record<TurnState, string>> = {
  zh: {
    IDLE: '空闲',
    PROMPT_SUBMITTED: '处理中',
    THINKING: '处理中',
    TOOL_RUNNING: '执行工具',
    WAITING_PERMISSION: '等待授权',
    WAITING_USER_INPUT: '等待输入',
    DONE: '已完成',
    ERROR: '执行失败',
    TIMEOUT: '疑似卡住',
    USAGE_LIMITED: '额度受限',
    CANCELLED: '已取消',
  },
  en: {
    IDLE: 'Idle',
    PROMPT_SUBMITTED: 'Processing',
    THINKING: 'Processing',
    TOOL_RUNNING: 'Using tools',
    WAITING_PERMISSION: 'Awaiting approval',
    WAITING_USER_INPUT: 'Awaiting input',
    DONE: 'Done',
    ERROR: 'Failed',
    TIMEOUT: 'Possibly stuck',
    USAGE_LIMITED: 'Usage limited',
    CANCELLED: 'Cancelled',
  },
}

export const WORK_STATE_CODES = Object.values(TurnState)
