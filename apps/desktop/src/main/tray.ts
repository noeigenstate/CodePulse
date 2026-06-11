/**
 * 系统托盘控制器：持有托盘图标、提示文本与右键菜单，
 * 并使它们与最新状态保持同步（需求 §5.6）。
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
 * 托盘菜单项触发的回调，由主进程提供。
 */
export interface TrayCallbacks {
  /** 打开/聚焦主窗口。 */
  onOpen: () => void
  /** 切换 30 分钟静音；接收新的静音状态。 */
  onToggleMute: (muted: boolean) => void
  /** 确认所有 agent 的未读结果。 */
  onClearAlerts: () => void
  /** 打开窗口并导航到设置页。 */
  onOpenSettings: () => void
  /** 退出应用。 */
  onQuit: () => void
}

/**
 * 持有系统托盘图标、提示文本与右键菜单。
 *
 * 状态变化时调用 {@link update}，刷新图标颜色、提示文本
 * 与各 agent 的菜单行。
 */
export class TrayController {
  /** Electron 托盘句柄。 */
  private tray: Tray
  /** 静音状态的本地镜像，用于菜单文案。 */
  private muted = false

  /**
   * 创建托盘（初始为空闲）并接线点击处理器。
   *
   * @param callbacks 主进程提供的菜单项处理器。
   */
  constructor(private callbacks: TrayCallbacks) {
    this.tray = new Tray(trayIconFor('idle'))
    this.tray.setToolTip('CodePulse')
    this.tray.on('click', () => this.callbacks.onOpen())
    this.update({ overall: 'idle', agents: [], updatedAt: Date.now() })
  }

  /**
   * 根据状态快照刷新图标、提示文本与右键菜单。
   *
   * @param snapshot 最新的聚合状态。
   */
  update(snapshot: StatusSnapshot): void {
    this.tray.setImage(trayIconFor(snapshot.overall))
    this.tray.setToolTip(`CodePulse — ${overallLabel(snapshot.overall)}`)
    this.tray.setContextMenu(this.buildMenu(snapshot))
  }

  /**
   * 更新菜单上显示的静音标志（本身不执行静音）。
   *
   * @param muted 新的静音状态。
   */
  setMuted(muted: boolean): void {
    this.muted = muted
  }

  /** 销毁底层托盘图标。 */
  destroy(): void {
    this.tray.destroy()
  }

  /**
   * 为给定快照构建右键菜单：标题、每个 agent 一行禁用状态行，
   * 然后是动作项（打开、静音、清除、设置、退出）。
   *
   * @param snapshot 最新的聚合状态。
   * @returns 构建好的 Electron 菜单。
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
 * 格式化单个 agent 的菜单行，例如 `"Claude Code: 执行工具"`。
 *
 * @param agent agent 的运行时状态。
 * @returns 菜单行字符串。
 */
function agentLine(agent: AgentRuntimeState): string {
  const name = agent.agentType === 'codex' ? 'Codex' : 'Claude Code'
  return `${name}: ${stateLabel(agent.state)}`
}

/**
 * 把轮次状态映射为托盘菜单使用的简短中文标签。
 *
 * @param state 轮次状态。
 * @returns 标签。
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
 * 把总体状态映射为提示文本使用的简短中文标签。
 *
 * @param overall 聚合后的总体状态。
 * @returns 标签。
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
