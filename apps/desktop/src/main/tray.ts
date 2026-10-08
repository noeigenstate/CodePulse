import { Menu, Tray, type MenuItemConstructorOptions } from 'electron'
import {
  AGENT_DISPLAY_NAMES,
  type AgentRuntimeState,
  type OverallState,
  type StatusSnapshot,
  TurnState,
  type UiLocale,
} from '@codepulse/shared'
import { trayIconFor } from './icon.js'

export interface TrayCallbacks {
  onOpen: () => void
  /** Put every CLI config back to its pre-CodePulse state, then quit. */
  onRestoreConfigsAndQuit: () => void
  onQuit: () => void
}

export class TrayController {
  private tray: Tray
  private snapshot: StatusSnapshot = { overall: 'idle', agents: [], updatedAt: Date.now() }
  private locale: UiLocale = 'en'

  constructor(private callbacks: TrayCallbacks) {
    this.tray = new Tray(trayIconFor('idle'))
    this.tray.setToolTip('CodePulse')
    this.tray.on('click', () => this.callbacks.onOpen())
    this.update(this.snapshot)
  }

  update(snapshot: StatusSnapshot): void {
    this.snapshot = snapshot
    this.tray.setImage(trayIconFor(snapshot.overall))
    this.tray.setToolTip(`CodePulse - ${OVERALL_LABELS[this.locale][snapshot.overall]}`)
    this.tray.setContextMenu(this.buildMenu(snapshot))
  }

  /** Follows the dashboard language; re-renders the tooltip and menu. */
  setLocale(locale: UiLocale): void {
    if (locale === this.locale) return
    this.locale = locale
    this.update(this.snapshot)
  }

  destroy(): void {
    this.tray.destroy()
  }

  private buildMenu(snapshot: StatusSnapshot): Menu {
    const copy = MENU_COPY[this.locale]
    const visibleAgents = snapshot.agents.filter((agent) => !agent.taskHidden)
    const agentItems: MenuItemConstructorOptions[] =
      visibleAgents.length > 0
        ? visibleAgents.map((agent) => ({ label: this.agentLine(agent), enabled: false }))
        : [{ label: copy.noAgents, enabled: false }]

    return Menu.buildFromTemplate([
      { label: 'CodePulse', enabled: false },
      { type: 'separator' },
      ...agentItems,
      { type: 'separator' },
      { label: copy.open, click: () => this.callbacks.onOpen() },
      { type: 'separator' },
      { label: copy.restoreConfigs, click: () => this.callbacks.onRestoreConfigsAndQuit() },
      { label: copy.quit, click: () => this.callbacks.onQuit() },
    ])
  }

  private agentLine(agent: AgentRuntimeState): string {
    const name = AGENT_DISPLAY_NAMES[agent.agentType] ?? 'Agent'
    return `${name}: ${STATE_LABELS[this.locale][agent.state] ?? agent.state}`
  }
}

const MENU_COPY: Record<
  UiLocale,
  { noAgents: string; open: string; restoreConfigs: string; quit: string }
> = {
  en: {
    noAgents: 'No active agents',
    open: 'Open dashboard',
    restoreConfigs: 'Restore CLI configs & quit…',
    quit: 'Quit',
  },
  zh: {
    noAgents: '暂无活动 Agent',
    open: '打开面板',
    restoreConfigs: '还原 CLI 配置并退出…',
    quit: '退出',
  },
}

const STATE_LABELS: Record<UiLocale, Partial<Record<TurnState, string>>> = {
  en: {
    [TurnState.IDLE]: 'Idle',
    [TurnState.PROMPT_SUBMITTED]: 'Processing',
    [TurnState.THINKING]: 'Processing',
    [TurnState.TOOL_RUNNING]: 'Using tools',
    [TurnState.WAITING_PERMISSION]: 'Needs permission',
    [TurnState.WAITING_USER_INPUT]: 'Waiting for input',
    [TurnState.DONE]: 'Done',
    [TurnState.ERROR]: 'Error',
    [TurnState.TIMEOUT]: 'May be stuck',
    [TurnState.USAGE_LIMITED]: 'Usage limit',
    [TurnState.CANCELLED]: 'Cancelled',
  },
  zh: {
    [TurnState.IDLE]: '空闲',
    [TurnState.PROMPT_SUBMITTED]: '处理中',
    [TurnState.THINKING]: '处理中',
    [TurnState.TOOL_RUNNING]: '执行工具',
    [TurnState.WAITING_PERMISSION]: '等待授权',
    [TurnState.WAITING_USER_INPUT]: '等待输入',
    [TurnState.DONE]: '已完成',
    [TurnState.ERROR]: '出错',
    [TurnState.TIMEOUT]: '疑似卡住',
    [TurnState.USAGE_LIMITED]: '用量上限',
    [TurnState.CANCELLED]: '已取消',
  },
}

const OVERALL_LABELS: Record<UiLocale, Record<OverallState, string>> = {
  en: {
    idle: 'Idle',
    running: 'Running',
    attention: 'Needs you',
    done_unread: 'Turn finished',
    error: 'Error',
    stuck: 'May be stuck',
    limited: 'Usage limit',
  },
  zh: {
    idle: '空闲',
    running: '执行中',
    attention: '需要介入',
    done_unread: '一轮完成',
    error: '出错',
    stuck: '疑似卡住',
    limited: '用量上限',
  },
}
