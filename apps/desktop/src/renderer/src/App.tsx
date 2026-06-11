/**
 * Dashboard 根组件。布局包含头部、agent 卡片网格与通知栏，
 * 并驱动 1 秒一跳的时钟，使耗时与相对时间保持实时。
 *
 * @module renderer/App
 */
import { useEffect, useState } from 'react'
import {
  formatTokenCount,
  formatTokenPercent,
  formatTokenUsage,
  type AgentRuntimeState,
  type AgentType,
  type TokenPayload,
  TurnState,
} from '@codepulse/shared'
import { useStore } from './store.js'
import { Header } from './components/Header.js'
import { NotificationsRail } from './components/NotificationsRail.js'
import {
  buildAgentPanels,
  latestQuotaToken,
  type AgentPanel,
  type AgentWorkspaceItem,
} from './lib/displayAgents.js'
import { formatDuration, formatRelative, turnStateStyle } from './lib/format.js'

/**
 * 应用外壳 Dashboard。
 *
 * @returns 渲染后的 Dashboard。
 */
export function App(): JSX.Element {
  const {
    snapshot,
    muted,
    agents,
    notifications,
    init,
    ack,
    clearAlerts,
    toggleMute,
    dismissNotification,
  } = useStore()
  const [now, setNow] = useState(() => Date.now())
  const panels = buildAgentPanels(snapshot.agents)
  const quotaToken = latestQuotaToken(snapshot.agents)

  useEffect(() => init(), [init])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="app-shell flex h-full flex-col text-slate-950">
      <Header
        overall={snapshot.overall}
        quotaToken={quotaToken}
        muted={muted}
        onToggleMute={toggleMute}
        onClearAlerts={clearAlerts}
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 overflow-hidden px-6 pb-6 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <main className="min-w-0 overflow-y-auto pr-1">
          <div className="space-y-5">
            {panels.map((panel) => (
              <AgentPanelView
                key={panel.agentType}
                panel={panel}
                now={now}
                onAck={(agentType, workspacePath) => ack(agentType, workspacePath)}
              />
            ))}
          </div>
        </main>
        <NotificationsRail
          agents={snapshot.agents}
          detectedAgents={agents}
          notifications={notifications}
          now={now}
          onDismiss={dismissNotification}
        />
      </div>
    </div>
  )
}

function AgentPanelView({
  panel,
  now,
  onAck,
}: {
  panel: AgentPanel
  now: number
  onAck: (agentType: AgentType, workspacePath?: string) => void
}): JSX.Element {
  const latest = panel.workspaces[0]?.agent
  const style = turnStateStyle(latest?.state ?? TurnState.IDLE)
  const projectCount = panel.workspaces.filter((item) => item.agent.lastEventAt > 0).length
  const isCodex = panel.agentType === 'codex'

  return (
    <section className="liquid-glass rounded-2xl p-5">
      <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <span className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-amber-300/30 bg-white/55 shadow-[0_18px_42px_rgb(61_80_111_/_0.12)]">
            <span className={`h-4 w-4 rounded-full ${style.dot}`} />
            <span className="absolute inset-3 rounded-full border border-amber-400/30" />
          </span>
          <div className="min-w-0">
            <p className="hud-label">Agent</p>
            <div className="flex min-w-0 items-center gap-3">
              <h2 className="truncate text-2xl font-semibold text-slate-950">{panel.name}</h2>
              <span className={`text-sm ${style.text}`}>{style.label}</span>
            </div>
            <p className="mt-1 truncate text-sm text-slate-500">
              {isCodex ? 'Codex 项目集中视图' : 'Claude Code 项目状态'}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm md:w-64">
          <Metric label="项目" value={String(projectCount || panel.workspaces.length)} />
          <Metric
            label="最近事件"
            value={latest?.lastEventAt ? formatRelative(latest.lastEventAt, now) : '—'}
          />
        </div>
      </div>
      <div
        className={`grid gap-3 ${
          isCodex && panel.workspaces.length > 1 ? 'grid-cols-1 2xl:grid-cols-2' : 'grid-cols-1'
        }`}
      >
        {panel.workspaces.map((item) => (
          <ProjectTile
            key={item.id}
            item={item}
            now={now}
            onAck={() => onAck(panel.agentType, item.workspacePath)}
          />
        ))}
      </div>
    </section>
  )
}

function ProjectTile({
  item,
  now,
  onAck,
}: {
  item: AgentWorkspaceItem
  now: number
  onAck: () => void
}): JSX.Element {
  const agent = item.agent
  const style = turnStateStyle(agent.state)
  const token = agent.token
  const contextWindow = effectiveContextWindow(agent)
  const contextPct = token?.contextUsedPercent
  const elapsed = agent.turnStartedAt ? formatDuration(now - agent.turnStartedAt) : '—'

  return (
    <article className="glass-subtle rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${style.dot}`} />
            <h3 className="truncate text-lg font-semibold text-slate-950">{item.name}</h3>
          </div>
          <p className="mt-1 truncate text-xs text-slate-500">
            {item.workspacePath ?? '等待项目路径'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`rounded-full px-2 py-1 text-xs ${stateChipClass(agent.state)}`}>
            {style.label}
          </span>
          {agent.unread && (
            <button
              onClick={onAck}
              className="rounded-full border border-emerald-300/50 bg-emerald-50/80 px-2.5 py-1 text-xs text-emerald-700 transition hover:bg-emerald-100 active:translate-y-px"
            >
              已读
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 text-sm xl:grid-cols-5">
        <Metric label="模型" value={agent.model ?? '—'} className="xl:col-span-2" />
        <Metric label="耗时" value={elapsed} />
        <Metric label="工具" value={String(agent.toolCallCount)} />
        <Metric label="Token" value={formatTokenCount(token?.total)} />
      </div>

      <div className="mt-4">
        <TokenMeter
          label="Context"
          percent={contextPct}
          detail={formatContextDetail(token, contextWindow)}
        />
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-xs">
        <p className="min-w-0 truncate text-slate-600">
          <span className="text-amber-700">当前</span> {agent.activity ?? '等待事件'}
        </p>
        <span className="shrink-0 text-slate-400">
          {agent.lastEventAt ? formatRelative(agent.lastEventAt, now) : '—'}
        </span>
      </div>
    </article>
  )
}

function TokenMeter({
  label,
  percent,
  detail,
}: {
  label: string
  percent: number | undefined
  detail: string
}): JSX.Element {
  const hasPercent = typeof percent === 'number'
  const width = hasPercent ? `${Math.min(100, Math.max(2, percent))}%` : '0%'

  return (
    <div className="rounded-xl border border-white/70 bg-white/45 px-3 py-2 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.7)]">
      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
        <span className="text-slate-500">{label}</span>
        <span className={hasPercent ? tokenTextColor(percent) : 'text-slate-400'}>
          {formatTokenPercent(percent)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-200/80 ring-1 ring-white/80">
        <div
          className={`neon-progress h-full rounded-full ${hasPercent ? tokenBarColor(percent) : 'bg-slate-300'}`}
          style={{ width }}
        />
      </div>
      <p className="mt-2 truncate text-[11px] text-slate-500">{detail}</p>
    </div>
  )
}

function Metric({
  label,
  value,
  className = '',
}: {
  label: string
  value: string
  className?: string
}): JSX.Element {
  return (
    <div className={`min-w-0 rounded-xl border border-white/70 bg-white/40 px-3 py-2 ${className}`}>
      <p className="text-[10px] text-slate-500">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-slate-950">{value}</p>
    </div>
  )
}

function formatContextDetail(
  token: TokenPayload | undefined,
  contextWindow: number | undefined,
): string {
  const windowText = contextWindow ? `窗口 ${formatTokenCount(contextWindow)}` : '窗口 —'
  return `${formatTokenUsage(token)} · ${windowText}`
}

function effectiveContextWindow(agent: AgentRuntimeState): number | undefined {
  return agent.token?.contextWindow ?? (agent.agentType === 'codex' ? 256_000 : undefined)
}

function stateChipClass(state: AgentRuntimeState['state']): string {
  switch (state) {
    case TurnState.DONE:
      return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
    case TurnState.ERROR:
      return 'bg-red-50 text-red-700 ring-1 ring-red-200'
    case TurnState.WAITING_PERMISSION:
    case TurnState.WAITING_USER_INPUT:
      return 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
    case TurnState.TIMEOUT:
      return 'bg-orange-50 text-orange-700 ring-1 ring-orange-200'
    case TurnState.THINKING:
    case TurnState.TOOL_RUNNING:
    case TurnState.PROMPT_SUBMITTED:
      return 'bg-blue-50 text-blue-700 ring-1 ring-blue-200'
    default:
      return 'bg-slate-100 text-slate-600 ring-1 ring-slate-200'
  }
}

function tokenBarColor(pct: number): string {
  if (pct >= 95) return 'bg-red-500 text-red-500'
  if (pct >= 80) return 'bg-amber-400 text-amber-400'
  return 'bg-amber-500 text-amber-500'
}

function tokenTextColor(pct: number): string {
  if (pct >= 95) return 'text-red-600'
  if (pct >= 80) return 'text-amber-700'
  return 'text-amber-700'
}
