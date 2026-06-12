/**
 * Dashboard 根组件。布局包含头部、agent 卡片网格与通知栏，
 * 并驱动高频时钟，使耗时与相对时间保持实时。
 *
 * @module renderer/App
 */
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  formatTokenPercent,
  type AgentRuntimeState,
  type AgentType,
  type TokenPayload,
  TurnState,
} from '@codepulse/shared'
import { useStore } from './store.js'
import { Header } from './components/Header.js'
import { buildAgentPanels, type AgentPanel, type AgentWorkspaceItem } from './lib/displayAgents.js'
import { formatDuration, formatRelative, turnStateStyle } from './lib/format.js'
import {
  formatContextWindowStatus,
  formatProjectDirectoryBadge,
  visibleRateLimitWindows,
} from './lib/panelFormat.js'
import { formatQuotaReset } from './lib/quotaFormat.js'
import { useNow } from './lib/useNow.js'
import {
  nextLocale,
  readStoredLocale,
  turnStateLabel,
  uiCopy,
  type Locale,
  type UiCopy,
} from './lib/i18n.js'

/**
 * 应用外壳 Dashboard。
 *
 * @returns 渲染后的 Dashboard。
 */
export function App(): JSX.Element {
  const { snapshot, muted, init, ack, toggleMute } = useStore()
  const [locale, setLocale] = useState<Locale>(() => readStoredLocale(window.localStorage))
  const panels = useMemo(() => buildAgentPanels(snapshot.agents), [snapshot.agents])
  const copy = useMemo(() => uiCopy(locale), [locale])

  useEffect(() => init(), [init])

  const toggleLocale = (): void => {
    setLocale((current) => {
      const next = nextLocale(current)
      window.localStorage.setItem('codepulse:locale', next)
      return next
    })
  }

  return (
    <div className="app-shell flex h-full flex-col text-slate-950">
      <Header
        overall={snapshot.overall}
        locale={locale}
        muted={muted}
        onToggleLocale={toggleLocale}
        onToggleMute={toggleMute}
      />
      <div className="min-h-0 flex-1 overflow-hidden px-4 pb-4">
        <main className="h-full min-w-0 overflow-x-auto overflow-y-hidden pr-1">
          <div className="grid h-full min-w-[56rem] grid-cols-[minmax(27rem,1fr)_minmax(27rem,1fr)] items-stretch gap-4">
            {panels.map((panel) => (
              <AgentPanelView
                key={panel.agentType}
                panel={panel}
                locale={locale}
                copy={copy}
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
  locale,
  copy,
  onAck,
}: {
  panel: AgentPanel
  locale: Locale
  copy: UiCopy
  onAck: (agentType: AgentType, workspacePath?: string) => void
}): JSX.Element {
  const latest = panel.workspaces[0]?.agent
  const style = turnStateStyle(latest?.state ?? TurnState.IDLE)
  const projectCount = panel.workspaces.filter((item) => item.agent.lastEventAt > 0).length

  return (
    <section className="liquid-glass agent-panel flex min-h-0 flex-col rounded-[1.35rem] p-3">
      <div className="mb-3 flex flex-col gap-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-[1rem] border border-amber-300/30 bg-white/55 shadow-[0_10px_24px_rgb(61_80_111_/_0.1)]">
            <span className={`h-3.5 w-3.5 rounded-full ${style.dot}`} />
            <span className="absolute inset-3 rounded-full border border-amber-400/30" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2.5">
              <h2 className="truncate text-xl font-semibold text-slate-950">{panel.name}</h2>
              <span
                className={`rounded-full px-2 py-0.5 text-xs ${stateChipClass(latest?.state ?? TurnState.IDLE)}`}
              >
                {turnStateLabel(latest?.state ?? TurnState.IDLE, locale)}
              </span>
            </div>
          </div>
          <div className="grid shrink-0 grid-cols-[4.4rem_5.7rem] gap-2 text-sm">
            <Metric label={copy.project} value={String(projectCount || panel.workspaces.length)} />
            <Metric label={copy.recent} value={<RelativeTime timestamp={latest?.lastEventAt} />} />
          </div>
        </div>
        <PanelQuotaMeter token={panel.quotaToken} copy={copy} />
      </div>
      <div className="agent-project-list grid min-h-0 flex-1 content-start gap-2 overflow-y-auto pr-1">
        {panel.workspaces.map((item) => (
          <ProjectTile
            key={item.id}
            item={item}
            locale={locale}
            copy={copy}
            onAck={() => onAck(panel.agentType, item.workspacePath)}
          />
        ))}
      </div>
    </section>
  )
})

const ProjectTile = memo(function ProjectTile({
  item,
  locale,
  copy,
  onAck,
}: {
  item: AgentWorkspaceItem
  locale: Locale
  copy: UiCopy
  onAck: () => void
}): JSX.Element {
  const agent = item.agent
  const style = turnStateStyle(agent.state)
  const token = agent.token
  const contextWindow = effectiveContextWindow(agent)

  return (
    <article className="glass-subtle project-tile rounded-xl px-3 py-2.5">
      <div className="grid gap-2.5">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="project-title-row">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${style.dot}`} />
              <h3 className="project-title">{item.name}</h3>
              <span className="project-directory-badge" title={item.workspacePath}>
                {formatProjectDirectoryBadge(item.workspacePath, item.name)}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className={`rounded-full px-2 py-1 text-xs ${stateChipClass(agent.state)}`}>
              {turnStateLabel(agent.state, locale)}
            </span>
            {agent.unread && (
              <button
                onClick={onAck}
                className="rounded-full border border-emerald-300/50 bg-emerald-50/80 px-2 py-1 text-xs text-emerald-700 transition hover:bg-emerald-100 active:translate-y-px"
              >
                {copy.read}
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-[minmax(7rem,1fr)_minmax(5.5rem,0.7fr)] gap-2">
          <InlineMetric label={copy.model} value={agent.model ?? '—'} />
          <InlineMetric label={copy.elapsed} value={<ElapsedTime since={agent.turnStartedAt} />} />
        </div>

        <ContextMeter token={token} contextWindow={contextWindow} copy={copy} />
      </div>
    </article>
  )
})

function PanelQuotaMeter({
  token,
  copy,
}: {
  token: TokenPayload | undefined
  copy: UiCopy
}): JSX.Element {
  const now = useNow()
  const { fiveHour, sevenDay } = visibleRateLimitWindows(token)
  const hasQuota = Boolean(fiveHour ?? sevenDay)

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
      <TokenMeter
        label={copy.fiveHourQuota}
        percent={fiveHour?.usedPercent}
        detail={hasQuota ? formatQuotaReset(fiveHour?.resetsAt, now) : copy.waitingQuota}
      />
      <TokenMeter
        label={copy.weeklyQuota}
        percent={sevenDay?.usedPercent}
        detail={hasQuota ? formatQuotaReset(sevenDay?.resetsAt, now) : copy.waitingQuota}
      />
    </div>
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

function ContextMeter({
  token,
  contextWindow,
  copy,
}: {
  token: TokenPayload | undefined
  contextWindow: number | undefined
  copy: UiCopy
}): JSX.Element {
  const status = formatContextWindowStatus(token, contextWindow)
  const usedPercent = status.usedPercent
  const hasPercent = typeof usedPercent === 'number'
  const width = hasPercent ? `${Math.min(100, Math.max(2, usedPercent))}%` : '0%'

  return (
    <div className="rounded-xl border border-white/70 bg-white/45 px-3 py-2 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.7)]">
      <div className="mb-1.5 flex min-w-0 items-center justify-between gap-2 text-xs">
        <span className="shrink-0 font-medium text-slate-500">{copy.contextWindow}</span>
        <span className="truncate font-semibold text-slate-900">{status.text}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-200/80 ring-1 ring-white/80">
        <div
          className={`h-full rounded-full ${hasPercent ? tokenBarColor(usedPercent) : 'bg-slate-300'}`}
          style={{ width }}
        />
      </div>
    </div>
  )
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
    <div className="rounded-xl border border-white/70 bg-white/45 px-3 py-1.5 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.7)]">
      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-slate-500">{label}</span>
        <span
          className={`font-semibold ${hasPercent ? tokenTextColor(percent) : 'text-slate-400'}`}
        >
          {formatTokenPercent(percent)}
        </span>
      </div>
      <div
        className={`${compact ? 'h-1.5' : 'h-2'} overflow-hidden rounded-full bg-slate-200/80 ring-1 ring-white/80`}
      >
        <div
          className={`neon-progress h-full rounded-full ${hasPercent ? tokenBarColor(percent) : 'bg-slate-300'}`}
          style={{ width }}
        />
      </div>
      <p
        className={`${compact ? 'mt-1' : 'mt-1.5'} truncate text-[11px] font-medium text-slate-500`}
      >
        {detail}
      </p>
    </div>
  )
}

function InlineMetric({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div className="min-w-0 rounded-xl border border-white/65 bg-white/42 px-2.5 py-1.5 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.58)]">
      <p className="text-[10px] font-medium text-slate-500">{label}</p>
      <p className="mt-0.5 truncate text-[13px] font-semibold text-slate-950">{value}</p>
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
    <div
      className={`min-w-0 rounded-xl border border-white/70 bg-white/40 px-2.5 py-1.5 ${className}`}
    >
      <p className="text-[10px] text-slate-500">{label}</p>
      <p className="mt-0.5 truncate text-[13px] font-semibold text-slate-950">{value}</p>
    </div>
  )
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
