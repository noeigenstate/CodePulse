/**
 * The system-tray controller: owns the tray icon, tooltip, and context menu and
 * keeps them in sync with the latest status (requirements §5.6).
 *
 * @module main/tray
 */
import { Menu, Tray, type MenuItemConstructorOptions } from 'electron'
import {
  type AgentRuntimeState,
  type OverallState,
  type StatusSnapshot,
  TurnState,
} from '@codepulse/shared'
import { trayIconFor } from './icon.js'

/**
 * Callbacks invoked by the tray menu items. Supplied by the main process.
 */
export interface TrayCallbacks {
  /** Open / focus the main window. */
  onOpen: () => void
  /** Toggle the 30-minute mute; receives the new muted state. */
  onToggleMute: (muted: boolean) => void
  /** Acknowledge all agents' unread results. */
  onClearAlerts: () => void
  /** Open the window and navigate to settings. */
  onOpenSettings: () => void
  /** Quit the application. */
  onQuit: () => void
}

/**
 * Owns the system-tray icon, tooltip, and context menu.
 *
 * Call {@link update} whenever the status changes to refresh the icon colour,
 * tooltip, and per-agent menu lines.
 */
export class TrayController {
  /** The Electron tray handle. */
  private tray: Tray
  /** Local mirror of the mute state, shown in the menu label. */
  private muted = false

  /**
   * Creates the tray (initially idle) and wires the click handler.
   *
   * @param callbacks Menu-item handlers supplied by the main process.
   */
  constructor(private callbacks: TrayCallbacks) {
    this.tray = new Tray(trayIconFor('idle'))
    this.tray.setToolTip('CodePulse')
    this.tray.on('click', () => this.callbacks.onOpen())
    this.update({ overall: 'idle', agents: [], updatedAt: Date.now() })
  }

  /**
   * Refreshes the icon, tooltip, and context menu from a status snapshot.
   *
   * @param snapshot The latest aggregated status.
   */
  update(snapshot: StatusSnapshot): void {
    this.tray.setImage(trayIconFor(snapshot.overall))
    this.tray.setToolTip(`CodePulse — ${overallLabel(snapshot.overall)}`)
    this.tray.setContextMenu(this.buildMenu(snapshot))
  }

  /**
   * Updates the muted flag shown on the menu (does not itself mute anything).
   *
   * @param muted The new muted state.
   */
  setMuted(muted: boolean): void {
    this.muted = muted
  }

  /** Destroys the underlying tray icon. */
  destroy(): void {
    this.tray.destroy()
  }

  /**
   * Builds the context menu for a given snapshot: a header, one disabled line
   * per agent, then the actions (open, mute, clear, settings, quit).
   *
   * @param snapshot The latest aggregated status.
   * @returns The constructed Electron menu.
   */
  private buildMenu(snapshot: StatusSnapshot): Menu {
    const agentItems: MenuItemConstructorOptions[] =
      snapshot.agents.length > 0
        ? snapshot.agents.map((a) => ({ label: agentLine(a), enabled: false }))
        : [{ label: '暂无活动的 Agent', enabled: false }]

    return Menu.buildFromTemplate([
      { label: 'CodePulse', enabled: false },
      { type: 'separator' },
      ...agentItems,
      { type: 'separator' },
      { label: '打开面板', click: () => this.callbacks.onOpen() },
      {
        label: this.muted ? '取消静音' : '静音 30 分钟',
        click: () => {
          this.muted = !this.muted
          this.callbacks.onToggleMute(this.muted)
        },
      },
      { label: '清除提醒', click: () => this.callbacks.onClearAlerts() },
      { label: '设置', click: () => this.callbacks.onOpenSettings() },
      { type: 'separator' },
      { label: '退出', click: () => this.callbacks.onQuit() },
    ])
  }
}

/**
 * Formats a single agent's menu line, e.g. `"Claude Code: 执行工具"`.
 *
 * @param agent The agent's runtime state.
 * @returns The menu line string.
 */
function agentLine(agent: AgentRuntimeState): string {
  const name = agent.agentType === 'codex' ? 'Codex' : 'Claude Code'
  return `${name}: ${stateLabel(agent.state)}`
}

/**
 * Maps a turn state to a short Chinese label for the tray menu.
 *
 * @param state The turn state.
 * @returns The label.
 */
function stateLabel(state: TurnState): string {
  switch (state) {
    case TurnState.IDLE:
      return '空闲'
    case TurnState.PROMPT_SUBMITTED:
    case TurnState.THINKING:
      return '处理中'
    case TurnState.TOOL_RUNNING:
      return '执行工具'
    case TurnState.WAITING_PERMISSION:
      return '等待授权'
    case TurnState.WAITING_USER_INPUT:
      return '等待输入'
    case TurnState.DONE:
      return '已完成'
    case TurnState.ERROR:
      return '出错'
    case TurnState.TIMEOUT:
      return '疑似卡住'
    case TurnState.CANCELLED:
      return '已取消'
    default:
      return state
  }
}

/**
 * Maps the overall state to a short Chinese label for the tooltip.
 *
 * @param overall The aggregated overall state.
 * @returns The label.
 */
function overallLabel(overall: OverallState): string {
  switch (overall) {
    case 'running':
      return '执行中'
    case 'attention':
      return '需要介入'
    case 'done_unread':
      return '一轮完成'
    case 'error':
      return '出错'
    case 'stuck':
      return '疑似卡住'
    default:
      return '空闲'
  }
}
