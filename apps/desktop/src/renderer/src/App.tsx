/**
 * Dashboard 根组件。布局包含头部、agent 卡片网格与通知栏，
 * 并驱动高频时钟，使耗时与相对时间保持实时。
 *
 * @module renderer/App
 */
import { memo, useEffect, useMemo, type ReactNode } from 'react'
import {
  TOKEN_QUOTA_WINDOW_LABEL,
  formatTokenCountWithUnit,
  formatTokenPercent,
  formatTokenUsage,
  type AgentRuntimeState,
  type AgentType,
  type TokenPayload,
  TurnState,
} from '@codepulse/shared'
import { useStore } from './store.js'
import { Header } from './components/Header.js'
import { buildAgentPanels, type AgentPanel, type AgentWorkspaceItem } from './lib/displayAgents.js'
import { formatDuration, formatRelative, turnStateStyle } from './lib/format.js'
import { formatQuotaDetail } from './lib/quotaFormat.js'
import { useNow } from './lib/useNow.js'

/**
 * 应用外壳 Dashboard。
 *
 * @returns 渲染后的 Dashboard。
 */
export function App(): JSX.Element {
  const { snapshot, muted, init, ack, clearAlerts, toggleMute } = useStore()
  const panels = useMemo(() => buildAgentPanels(snapshot.agents), [snapshot.agents])

  useEffect(() => init(), [init])

  return (
    <div className="app-shell flex h-full flex-col text-slate-950">
      <Header
        overall={snapshot.overall}
        muted={muted}
        onToggleMute={toggleMute}
        onClearAlerts={clearAlerts}
      />
      <div className="min-h-0 flex-1 overflow-hidden px-5 pb-5">
        <main className="h-full min-w-0 overflow-y-auto pr-1">
          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
            {panels.map((panel) => (
              <AgentPanelView
                key={panel.agentType}
                panel={panel}
                onAck={(agentType, workspacePath) => ack(agentType, workspacePath)}
              />
            ))}
          </div>
        </main>
      </div>
    </div>
  )
}

const AgentPanelView = memo(function AgentPanelView({
  panel,
  onAck,
}: {
  panel: AgentPanel
  onAck: (agentType: AgentType, workspacePath?: string) => void
}): JSX.Element {
  const latest = panel.workspaces[0]?.agent
  const style = turnStateStyle(latest?.state ?? TurnState.IDLE)
  const projectCount = panel.workspaces.filter((item) => item.agent.lastEventAt > 0).length
  const isCodex = panel.agentType === 'codex'

  return (
    <section className="liquid-glass rounded-2xl p-4">
      <div className="mb-3 flex flex-col gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-amber-300/30 bg-white/55 shadow-[0_14px_34px_rgb(61_80_111_/_0.1)]">
            <span className={`h-3.5 w-3.5 rounded-full ${style.dot}`} />
            <span className="absolute inset-3 rounded-full border border-amber-400/30" />
          </span>
          <div className="min-w-0">
            <p className="hud-label">Agent</p>
            <div className="flex min-w-0 items-center gap-3">
              <h2 className="truncate text-xl font-semibold text-slate-950">{panel.name}</h2>
              <span className={`text-sm ${style.text}`}>{style.label}</span>
            </div>
            <p className="mt-1 truncate text-sm text-slate-500">
              {isCodex ? 'Codex 项目集中视图' : 'Claude Code 项目状态'}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-[5rem_6.5rem_minmax(0,1fr)]">
          <Metric label="项目" value={String(projectCount || panel.workspaces.length)} />
          <Metric label="最近事件" value={<RelativeTime timestamp={latest?.lastEventAt} />} />
          <div className="col-span-2 sm:col-span-1">
            <PanelQuotaMeter token={panel.quotaToken} />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3">
        {panel.workspaces.map((item) => (
          <ProjectTile
            key={item.id}
            item={item}
            onAck={() => onAck(panel.agentType, item.workspacePath)}
          />
        ))}
      </div>
    </section>
  )
})

const ProjectTile = memo(function ProjectTile({
  item,
  onAck,
}: {
  item: AgentWorkspaceItem
  onAck: () => void
}): JSX.Element {
  const agent = item.agent
  const style = turnStateStyle(agent.state)
  const token = agent.token
  const contextWindow = effectiveContextWindow(agent)
  const contextPct = token?.contextUsedPercent

  return (
    <article className="glass-subtle rounded-xl px-4 py-3">
      <div className="grid gap-3">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${style.dot}`} />
              <h3 className="truncate text-base font-semibold text-slate-950">{item.name}</h3>
            </div>
            <p className="mt-1 truncate text-xs font-medium text-slate-500">
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

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(7rem,1.5fr)_minmax(4.5rem,0.8fr)_minmax(4rem,0.7fr)_minmax(6rem,0.9fr)]">
          <InlineMetric label="模型" value={agent.model ?? '—'} />
          <InlineMetric label="耗时" value={<ElapsedTime since={agent.turnStartedAt} />} />
          <InlineMetric label="工具" value={String(agent.toolCallCount)} />
          <InlineMetric label="Token" value={formatTokenCountWithUnit(token?.total)} />
        </div>

        <TokenMeter
          label="Context"
          percent={contextPct}
          detail={formatContextDetail(token, contextWindow)}
          compact
        />
      </div>

      <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-white/60 bg-white/35 px-3 py-2 text-xs">
        <p className="min-w-0 truncate font-medium text-slate-800">
          <span className="font-semibold text-amber-700">当前</span> {agent.activity ?? '等待事件'}
        </p>
        <span className="shrink-0 font-semibold text-slate-500">
          <RelativeTime timestamp={agent.lastEventAt} />
        </span>
      </div>
    </article>
  )
})

function PanelQuotaMeter({ token }: { token: TokenPayload | undefined }): JSX.Element {
  const now = useNow()
  const fiveHour = token?.rateLimits?.fiveHour
  const detail = formatQuotaDetail(token, now)

  return (
    <TokenMeter label={TOKEN_QUOTA_WINDOW_LABEL} percent={fiveHour?.usedPercent} detail={detail} />
  )
}

function RelativeTime({ timestamp }: { timestamp: number | undefined }): JSX.Element {
  const now = useNow()
  return <>{timestamp ? formatRelative(timestamp, now) : '—'}</>
}

function ElapsedTime({ since }: { since: number | undefined }): JSX.Element {
  const now = useNow()
  return <>{since ? formatDuration(now - since) : '—'}</>
}

function TokenMeter({
  label,
  percent,
  detail,
  compact = false,
}: {
  label: string
  percent: number | undefined
  detail: string
  compact?: boolean
}): JSX.Element {
  const hasPercent = typeof percent === 'number'
  const width = hasPercent ? `${Math.min(100, Math.max(2, percent))}%` : '0%'

  return (
    <div
      className={`rounded-xl border border-white/70 bg-white/45 px-3 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.7)] ${
        compact ? 'py-1.5' : 'py-2'
      }`}
    >
      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-slate-500">{label}</span>
        <span
          className={`font-semibold ${hasPercent ? tokenTextColor(percent) : 'text-slate-400'}`}
        >
          {formatTokenPercent(percent)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-200/80 ring-1 ring-white/80">
        <div
          className={`neon-progress h-full rounded-full ${hasPercent ? tokenBarColor(percent) : 'bg-slate-300'}`}
          style={{ width }}
        />
      </div>
      <p className={`${compact ? 'mt-1' : 'mt-2'} truncate text-[11px] font-medium text-slate-500`}>
        {detail}
      </p>
    </div>
  )
}

function InlineMetric({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div className="min-w-0 rounded-xl border border-white/65 bg-white/42 px-3 py-2 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.58)]">
      <p className="text-[10px] font-medium text-slate-500">{label}</p>
      <p className="mt-0.5 truncate text-sm font-semibold text-slate-950">{value}</p>
    </div>
  )
}

function Metric({
  label,
  value,
  className = '',
}: {
  label: string
  value: ReactNode
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
  const windowText = contextWindow ? `窗口 ${formatTokenCountWithUnit(contextWindow)}` : '窗口 —'
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
