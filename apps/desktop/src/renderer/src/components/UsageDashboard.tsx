/**
 * Usage dashboard: token usage per CLI from the usage ledger, priced at official
 * API list prices, with per-project / per-model breakdowns and rounds per problem.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AGENT_DISPLAY_NAMES,
  formatTokenCount,
  type AgentType,
  type StatsRangePreset,
  type UsageLedgerSnapshot,
} from '@codepulse/shared'
import type { Locale, UsageCopy } from '../lib/i18n.js'
import { formatRelative } from '../lib/format.js'
import { formatModelName } from '../lib/modelName.js'
import { AgentLogo } from './AgentLogo.js'
import './usage-dashboard.css'

interface Props {
  locale: Locale
  copy: UsageCopy
  onClose: () => void
}

/** Fixed order for the token-type bar; colors live in usage-dashboard.css. */
const TOKEN_KINDS = ['input', 'cacheWrite', 'cacheRead', 'output'] as const
type TokenKind = (typeof TOKEN_KINDS)[number]

export function UsageDashboard({ locale, copy, onClose }: Props): JSX.Element {
  const [range, setRange] = useState<StatsRangePreset>('7d')
  const [data, setData] = useState<UsageLedgerSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(false)
    try {
      setData(await window.codepulse.getUsage({ range }))
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [range])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const empty = data !== null && data.totals.requests === 0 && data.totals.rounds === 0

  return (
    <div className="usage-page flex min-h-0 flex-1 flex-col text-ink">
      <header className="usage-topbar">
        <button type="button" className="control-btn" onClick={onClose}>
          <BackIcon />
          <span>{copy.back}</span>
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-module font-bold text-ink">{copy.title}</h1>
          <p className="truncate text-meta text-ink-500">{copy.subtitle}</p>
        </div>
        <div className="usage-segmented" role="tablist">
          {(
            [
              ['today', copy.rangeToday],
              ['7d', copy.range7d],
              ['30d', copy.range30d],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={range === value}
              className={range === value ? 'is-on' : ''}
              onClick={() => setRange(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="control-btn control-btn-icon"
          onClick={() => void load()}
          disabled={loading}
          aria-label={copy.refresh}
          title={
            data?.scannedAt
              ? copy.syncedAt.replace('{time}', formatRelative(data.scannedAt, Date.now(), locale))
              : copy.refresh
          }
        >
          <RefreshIcon spin={loading} />
        </button>
      </header>

      <div className="usage-scroll min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <StateMessage title={copy.error} />
        ) : !data ? (
          <StateMessage title={copy.loading} />
        ) : empty ? (
          <StateMessage title={copy.emptyTitle} body={copy.emptyBody} />
        ) : (
          <DashboardBody data={data} copy={copy} locale={locale} />
        )}
      </div>
    </div>
  )
}

function DashboardBody({
  data,
  copy,
  locale,
}: {
  data: UsageLedgerSnapshot
  copy: UsageCopy
  locale: Locale
}): JSX.Element {
  const t = data.totals
  const costPerRound = t.rounds > 0 ? t.costUsd / t.rounds : undefined
  const previousPerRound =
    data.previous.rounds > 0 ? data.previous.costUsd / data.previous.rounds : undefined

  return (
    <div className="usage-grid">
      <section className="usage-kpis">
        <Kpi
          label={copy.kpiCost}
          value={formatUsd(t.costUsd)}
          delta={delta(t.costUsd, data.previous.costUsd)}
          copy={copy}
          foot={
            t.unpricedTokens > 0
              ? copy.unpriced.replace('{tokens}', formatTokenCount(t.unpricedTokens))
              : copy.requests.replace('{n}', t.requests.toLocaleString())
          }
        />
        <Kpi
          label={copy.kpiTokens}
          value={formatTokenCount(t.tokens)}
          delta={delta(t.tokens, data.previous.tokens)}
          copy={copy}
          foot={<TokenMix totals={t} copy={copy} />}
        />
        <Kpi
          label={copy.kpiRounds}
          value={t.rounds.toLocaleString()}
          delta={delta(t.rounds, data.previous.rounds)}
          copy={copy}
          foot={`${copy.sessions.replace('{n}', String(t.sessions))} · ${copy.projects.replace('{n}', String(t.projects))}`}
        />
        <Kpi
          label={copy.kpiCostPerRound}
          value={costPerRound === undefined ? '—' : formatUsd(costPerRound)}
          delta={
            costPerRound === undefined ? undefined : delta(costPerRound, previousPerRound ?? 0)
          }
          copy={copy}
          foot={
            t.rounds > 0
              ? copy.tokensPerRound.replace('{tokens}', formatTokenCount(t.tokens / t.rounds))
              : ''
          }
        />
      </section>

      <section className="usage-card usage-tools">
        <h2 className="usage-h2">{copy.byTool}</h2>
        <div className="usage-tool-list">
          {data.byAgent.map((agent) => (
            <ToolCard
              key={agent.agentType}
              agent={agent}
              share={t.costUsd > 0 ? agent.costUsd / t.costUsd : 0}
              topModel={data.byModel.find((m) => m.agentType === agent.agentType)?.model}
              copy={copy}
            />
          ))}
        </div>
      </section>

      <section className="usage-card usage-trend">
        <div className="usage-card-head">
          <h2 className="usage-h2">{copy.trendTitle}</h2>
          <span className="usage-muted">
            {data.trendBucket === 'hour' ? copy.trendHourly : copy.trendDaily}
          </span>
        </div>
        <TrendChart data={data} locale={locale} copy={copy} />
      </section>

      <section className="usage-card">
        <h2 className="usage-h2">{copy.byProject}</h2>
        <table className="usage-table">
          <thead>
            <tr>
              <th>{copy.colProject}</th>
              <th className="num">{copy.colRounds}</th>
              <th className="num">{copy.colTokens}</th>
              <th className="num">{copy.colCost}</th>
            </tr>
          </thead>
          <tbody>
            {data.byProject.slice(0, 12).map((project) => (
              <tr key={project.path || project.name}>
                <td>
                  <div className="usage-name-cell" title={project.path}>
                    <span className="usage-agent-stack">
                      {project.agents.map((agent) => (
                        <span key={agent} className="usage-agent-dot" data-agent={agent}>
                          <AgentLogo agentType={agent} />
                        </span>
                      ))}
                    </span>
                    <span className="truncate font-medium">{project.name}</span>
                  </div>
                  <ShareBar value={t.costUsd > 0 ? project.costUsd / t.costUsd : 0} />
                </td>
                <td className="num">{project.rounds || '—'}</td>
                <td className="num">{formatTokenCount(project.tokens)}</td>
                <td className="num strong">{formatUsd(project.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="usage-card">
        <h2 className="usage-h2">{copy.byModel}</h2>
        <table className="usage-table">
          <thead>
            <tr>
              <th>{copy.colModel}</th>
              <th className="num">{copy.colRequests}</th>
              <th className="num">{copy.colAvgRounds}</th>
              <th className="num">{copy.colCost}</th>
            </tr>
          </thead>
          <tbody>
            {data.byModel.map((model) => {
              const rounds = data.modelRounds.find((m) => m.model === model.model)
              return (
                <tr key={`${model.agentType}:${model.model}`}>
                  <td>
                    <div className="usage-name-cell">
                      <span className="usage-agent-dot" data-agent={model.agentType}>
                        <AgentLogo agentType={model.agentType} />
                      </span>
                      <span className="truncate font-medium" title={model.model}>
                        {formatModelName(model.model)}
                      </span>
                      {!model.priced && <span className="usage-tag">{copy.noPrice}</span>}
                    </div>
                    <p className="usage-muted mt-0.5">{formatTokenCount(model.tokens)} tokens</p>
                  </td>
                  <td className="num">{model.requests.toLocaleString()}</td>
                  <td className="num">{rounds ? rounds.avgRounds.toFixed(1) : '—'}</td>
                  <td className="num strong">{model.priced ? formatUsd(model.costUsd) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      <section className="usage-card usage-rounds">
        <div className="usage-card-head">
          <h2 className="usage-h2">{copy.roundsTitle}</h2>
        </div>
        <p className="usage-muted mb-3">{copy.roundsHint}</p>
        <ol className="usage-session-list">
          {data.sessions.map((session) => (
            <li key={`${session.agentType}:${session.sessionId}`} className="usage-session">
              <div className="usage-session-rounds">
                <strong>{session.rounds}</strong>
                <span>{copy.roundsUnit}</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-ink" title={session.title}>
                  {session.title || copy.untitled}
                </p>
                <p className="usage-muted mt-0.5 flex min-w-0 items-center gap-1.5">
                  <span className="usage-agent-dot" data-agent={session.agentType}>
                    <AgentLogo agentType={session.agentType} />
                  </span>
                  <span className="truncate">
                    {session.projectName} ·{' '}
                    {formatRelative(session.lastActiveAt, Date.now(), locale)}
                  </span>
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {session.models.map((model) => (
                    <span key={model.model} className="usage-chip">
                      {model.model === '—' ? '—' : formatModelName(model.model)} × {model.rounds}
                    </span>
                  ))}
                </div>
              </div>
              <div className="usage-session-cost">
                <strong>{formatUsd(session.costUsd)}</strong>
                <span>{formatTokenCount(session.tokens)} tokens</span>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <p className="usage-footnote">{copy.footnote.replace('{date}', data.pricingAsOf)}</p>
    </div>
  )
}

function Kpi({
  label,
  value,
  delta: change,
  foot,
  copy,
}: {
  label: string
  value: string
  delta: number | undefined
  foot: ReactNode
  copy: UsageCopy
}): JSX.Element {
  return (
    <div className="usage-card usage-kpi fx-spot">
      <p className="usage-kpi-label">{label}</p>
      <p className="usage-kpi-value">{value}</p>
      <p className="usage-kpi-delta">
        {change === undefined ? (
          copy.noPrevious
        ) : (
          <>
            <span className={change > 0 ? 'is-up' : change < 0 ? 'is-down' : ''}>
              {change > 0 ? '▲' : change < 0 ? '▼' : '■'} {Math.abs(change * 100).toFixed(0)}%
            </span>{' '}
            {copy.vsPrevious}
          </>
        )}
      </p>
      <div className="usage-kpi-foot">{foot}</div>
    </div>
  )
}

function TokenMix({
  totals,
  copy,
}: {
  totals: UsageLedgerSnapshot['totals']
  copy: UsageCopy
}): JSX.Element {
  const values: Record<TokenKind, number> = {
    input: totals.input,
    cacheWrite: totals.cacheWrite,
    cacheRead: totals.cacheRead,
    output: totals.output,
  }
  const labels: Record<TokenKind, string> = {
    input: copy.tokenInput,
    cacheWrite: copy.tokenCacheWrite,
    cacheRead: copy.tokenCacheRead,
    output: copy.tokenOutput,
  }
  const sum = totals.tokens || 1
  return (
    <div>
      <div className="usage-mix-bar" aria-hidden="true">
        {TOKEN_KINDS.map((kind) =>
          values[kind] > 0 ? (
            <span
              key={kind}
              data-kind={kind}
              style={{ flexGrow: Math.max(values[kind] / sum, 0.012) }}
            />
          ) : null,
        )}
      </div>
      <ul className="usage-mix-legend">
        {TOKEN_KINDS.map((kind) => (
          <li key={kind}>
            <i data-kind={kind} />
            {labels[kind]} <b>{formatTokenCount(values[kind])}</b>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ToolCard({
  agent,
  share,
  topModel,
  copy,
}: {
  agent: UsageLedgerSnapshot['byAgent'][number]
  share: number
  topModel: string | undefined
  copy: UsageCopy
}): JSX.Element {
  return (
    <article className="usage-tool fx-spot fx-tilt" data-agent={agent.agentType}>
      <div className="flex items-center gap-2.5">
        <span className="agent-brand-icon usage-tool-icon" data-agent={agent.agentType}>
          <AgentLogo agentType={agent.agentType} />
        </span>
        <div className="min-w-0">
          <p className="truncate font-semibold text-ink">{AGENT_DISPLAY_NAMES[agent.agentType]}</p>
          <p className="usage-muted truncate">
            {copy.topModel}: {topModel ? formatModelName(topModel) : '—'}
          </p>
        </div>
      </div>
      <p className="usage-tool-cost">{formatUsd(agent.costUsd)}</p>
      <ShareBar value={share} agent={agent.agentType} />
      <p className="usage-muted mt-1.5">{copy.costShare.replace('{pct}', formatPct(share))}</p>
      <dl className="usage-tool-stats">
        <div>
          <dt>{copy.colTokens}</dt>
          <dd>{formatTokenCount(agent.tokens)}</dd>
        </div>
        <div>
          <dt>{copy.colRounds}</dt>
          <dd>{agent.rounds.toLocaleString()}</dd>
        </div>
        <div>
          <dt>{copy.colRequests}</dt>
          <dd>{agent.requests.toLocaleString()}</dd>
        </div>
      </dl>
    </article>
  )
}

function ShareBar({ value, agent }: { value: number; agent?: AgentType }): JSX.Element {
  return (
    <div className="usage-share" aria-hidden="true">
      <span data-agent={agent} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  )
}

/** Single-series cost bars; per-tool split lives in the tooltip, not in color. */
function TrendChart({
  data,
  locale,
  copy,
}: {
  data: UsageLedgerSnapshot
  locale: Locale
  copy: UsageCopy
}): JSX.Element {
  const [hover, setHover] = useState<number | undefined>()
  const points = data.trend
  const max = useMemo(() => niceMax(Math.max(0, ...points.map((p) => p.costUsd))), [points])
  const hourly = data.trendBucket === 'hour'
  const labelEvery = Math.max(1, Math.ceil(points.length / (hourly ? 8 : 10)))
  const hovered = hover === undefined ? undefined : points[hover]

  const label = (ts: number): string => {
    const d = new Date(ts)
    if (hourly) return `${String(d.getHours()).padStart(2, '0')}:00`
    return locale === 'zh'
      ? `${d.getMonth() + 1}/${d.getDate()}`
      : `${d.getMonth() + 1}/${d.getDate()}`
  }

  return (
    <div className="usage-chart" onMouseLeave={() => setHover(undefined)}>
      <div className="usage-chart-grid" aria-hidden="true">
        {[1, 0.5, 0].map((f) => (
          <div key={f} style={{ bottom: `${f * 100}%` }}>
            <span>{formatUsd(max * f)}</span>
          </div>
        ))}
      </div>
      <div className="usage-chart-bars">
        {points.map((point, index) => (
          <button
            type="button"
            key={point.bucketStart}
            className={`usage-bar ${hover === index ? 'is-hover' : ''}`}
            onMouseEnter={() => setHover(index)}
            onFocus={() => setHover(index)}
            aria-label={`${label(point.bucketStart)} ${formatUsd(point.costUsd)}`}
          >
            <span style={{ height: `${max > 0 ? (point.costUsd / max) * 100 : 0}%` }} />
            <em>{index % labelEvery === 0 ? label(point.bucketStart) : ''}</em>
          </button>
        ))}
      </div>
      {hovered && hover !== undefined && (
        <div
          className="usage-tooltip"
          style={{ left: `${((hover + 0.5) / points.length) * 100}%` }}
          role="status"
        >
          <p className="font-semibold">{label(hovered.bucketStart)}</p>
          <p>
            {formatUsd(hovered.costUsd)} · {formatTokenCount(hovered.tokens)} tokens
          </p>
          {Object.entries(hovered.byAgent)
            .filter(([, cost]) => (cost ?? 0) > 0)
            .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
            .map(([agent, cost]) => (
              <p key={agent} className="usage-tooltip-row">
                <span>{AGENT_DISPLAY_NAMES[agent as AgentType]}</span>
                <b>{formatUsd(cost ?? 0)}</b>
              </p>
            ))}
          {hovered.costUsd === 0 && <p className="usage-muted">{copy.emptyTitle}</p>}
        </div>
      )}
    </div>
  )
}

function StateMessage({ title, body }: { title: string; body?: string }): JSX.Element {
  return (
    <div className="flex h-full min-h-[18rem] flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-module font-semibold text-ink">{title}</p>
      {body && <p className="max-w-md text-meta text-ink-500">{body}</p>}
    </div>
  )
}

/** Relative change, or `undefined` when the previous period has nothing to compare. */
function delta(current: number, previous: number): number | undefined {
  if (!(previous > 0)) return undefined
  return (current - previous) / previous
}

function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return '<$0.01'
  if (value >= 10_000) return `$${(value / 1000).toFixed(1)}K`
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0)}%`
}

/** Rounds the axis maximum up to 1 / 2 / 5 × 10^n. */
function niceMax(value: number): number {
  if (value <= 0) return 1
  const exp = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * exp) return step * exp
  }
  return 10 * exp
}

function BackIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 4.5 6.5 10l5.5 5.5" />
    </svg>
  )
}

function RefreshIcon({ spin }: { spin: boolean }): JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      className={`h-4 w-4 ${spin ? 'animate-spin' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16 10a6 6 0 1 1-1.8-4.3M16 3.5v3.2h-3.2" />
    </svg>
  )
}
