import { Menu, Tray, type MenuItemConstructorOptions } from 'electron'
import {
  type AgentRuntimeState,
  type OverallState,
  type StatusSnapshot,
  TurnState,
} from '@codepulse/shared'
import { trayIconFor } from './icon.js'

export interface TrayCallbacks {
  onOpen: () => void
  onToggleMute: (muted: boolean) => void
  onQuit: () => void
}

export class TrayController {
  private tray: Tray
  private muted = false
  private snapshot: StatusSnapshot = { overall: 'idle', agents: [], updatedAt: Date.now() }

  constructor(private callbacks: TrayCallbacks) {
    this.tray = new Tray(trayIconFor('idle'))
    this.tray.setToolTip('CodePulse')
    this.tray.on('click', () => this.callbacks.onOpen())
    this.update(this.snapshot)
  }

  update(snapshot: StatusSnapshot): void {
    this.snapshot = snapshot
    this.tray.setImage(trayIconFor(snapshot.overall))
    this.tray.setToolTip(`CodePulse - ${overallLabel(snapshot.overall)}`)
    this.tray.setContextMenu(this.buildMenu(snapshot))
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.tray.setContextMenu(this.buildMenu(this.snapshot))
  }

  destroy(): void {
    this.tray.destroy()
  }

  private buildMenu(snapshot: StatusSnapshot): Menu {
    const visibleAgents = snapshot.agents.filter((agent) => !agent.taskHidden)
    const agentItems: MenuItemConstructorOptions[] =
      visibleAgents.length > 0
        ? visibleAgents.map((agent) => ({ label: agentLine(agent), enabled: false }))
        : [{ label: '暂无活动 Agent', enabled: false }]

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
      { type: 'separator' },
      { label: '退出', click: () => this.callbacks.onQuit() },
    ])
  }
}

function agentLine(agent: AgentRuntimeState): string {
  const name = agent.agentType === 'codex' ? 'Codex' : 'Claude Code'
  return `${name}: ${stateLabel(agent.state)}`
}

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
    case TurnState.USAGE_LIMITED:
      return '用量上限'
    case TurnState.CANCELLED:
      return '已取消'
    default:
      return state
  }
}

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
    case 'limited':
      return '用量上限'
    default:
      return '空闲'
  }
}
