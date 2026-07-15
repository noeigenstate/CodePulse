/**
 * 本地开发数据统计后台 —— 按设计稿实现的全屏统计台。
 * 数据经 IPC 从本机 SQLite 同步，支持时间范围与趋势粒度切换。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  formatTokenCount,
  type StatsDelta,
  type StatsInsight,
  type StatsRangePreset,
  type StatsTrendGranularity,
  type StatsTrendPoint,
  type UsageStatsSnapshot,
} from '@codepulse/shared'
import type { Locale, StatsCopy, UiCopy } from '../lib/i18n.js'
import { formatRelative } from '../lib/format.js'
import codePulseIcon from '../assets/codepulse-icon.png'

const MODEL_COLORS = ['#6366F1', '#3B82F6', '#F59E0B', '#94A3B8', '#A78BFA', '#34D399', '#F472B6']
const TYPE_COLORS = ['#6366F1', '#34D399', '#3B82F6', '#94A3B8', '#F59E0B']

interface Props {
  locale: Locale
  copy: UiCopy
  onClose: () => void
}

export function StatsDashboard({ locale, copy, onClose }: Props): JSX.Element {
  const s = copy.stats
  const [range, setRange] = useState<StatsRangePreset>('7d')
  const [granularity, setGranularity] = useState<StatsTrendGranularity>('day')
  const [stats, setStats] = useState<UsageStatsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true)
      else setRefreshing(true)
      setError(undefined)
      try {
        const api = window.codepulse
        if (!api?.getStats) {
          setError(s.syncFailed)
          setStats(null)
          return
        }
        const next = await api.getStats({ range, granularity })
        setStats(next)
      } catch {
        setError(s.syncFailed)
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [range, granularity, s.syncFailed],
  )

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

  const rangeLabel = useMemo(() => {
    if (!stats) return '—'
    return formatRangeLabel(stats.rangeStart, stats.rangeEnd)
  }, [stats])

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-[#F6F8FC] text-ink">
      <div className="app-shell flex h-full min-h-0 flex-col">
        {/* Top bar */}
        <header className="shrink-0 border-b border-line bg-white/80 px-5 py-3 backdrop-blur-md">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <img
                src={codePulseIcon}
                alt=""
                className="h-9 w-9 shrink-0 rounded-full object-contain shadow-soft"
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-module font-bold text-ink">{s.title}</h1>
                  <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-600 ring-1 ring-indigo-100">
                    {s.pageTitle}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-meta text-ink-500">{s.subtitle}</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-1 rounded-badge border border-line bg-white px-2.5 py-1.5 text-meta text-ink-700 shadow-soft">
                <CalendarIcon />
                <span className="tabular-nums">{rangeLabel}</span>
              </div>
              <Segmented
                value={range}
                options={[
                  { value: 'today', label: s.rangeToday },
                  { value: '7d', label: s.range7d },
                  { value: '30d', label: s.range30d },
                ]}
                onChange={(v) => setRange(v as StatsRangePreset)}
              />
              <button
                type="button"
                className="control-btn"
                disabled={loading || refreshing}
                onClick={() => void load({ silent: true })}
              >
                <RefreshIcon spin={refreshing || loading} />
                <span>{refreshing || loading ? s.refreshing : s.refresh}</span>
              </button>
              <button type="button" className="control-btn" onClick={onClose}>
                <span>{s.backToLive}</span>
              </button>
            </div>
          </div>
        </header>

        {/* Body — clip horizontal overflow so 30d charts cannot blow the shell width */}
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-4">
          {loading && !stats ? (
            <div className="flex h-full min-h-[20rem] items-center justify-center text-sm text-ink-500">
              {s.loading}
            </div>
          ) : error && !stats ? (
            <div className="flex h-full min-h-[20rem] flex-col items-center justify-center gap-3">
              <p className="text-sm text-red-600">{error}</p>
              <button type="button" className="control-btn" onClick={() => void load()}>
                {s.refresh}
              </button>
            </div>
          ) : stats ? (
            <StatsBody
              stats={stats}
              s={s}
              locale={locale}
              granularity={granularity}
              onGranularity={setGranularity}
            />
          ) : null}
        </div>

        <footer className="footer-strip flex shrink-0 items-center justify-between gap-3 px-6 py-2">
          <span>{s.privacyNote}</span>
          <span className="tabular-nums">
            {stats
              ? locale === 'zh'
                ? `同步 ${formatRelative(stats.generatedAt, Date.now(), locale)}`
                : `Synced ${formatRelative(stats.generatedAt, Date.now(), locale)}`
              : '—'}
          </span>
        </footer>
      </div>
    </div>
  )
}

function StatsBody({
  stats,
  s,
  locale,
  granularity,
  onGranularity,
}: {
  stats: UsageStatsSnapshot
  s: StatsCopy
  locale: Locale
  granularity: StatsTrendGranularity
  onGranularity: (g: StatsTrendGranularity) => void
}): JSX.Element {
  const k = stats.kpis
  const vsLabel = stats.rangePreset === '7d' ? s.vsPrevWeek : s.vsPrev

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-[1400px] flex-col gap-4">
      {/* Section head */}
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-module text-ink">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
              <SparkIcon />
            </span>
            {s.overview}
          </h2>
          <p className="mt-1 text-meta text-ink-500">{s.pageSubtitle}</p>
        </div>
        <p className="max-w-full shrink text-meta text-ink-400 sm:max-w-[18rem] sm:text-right">
          {s.overviewHint}
        </p>
      </div>

      {!stats.hasData && (
        <div
          className={`rounded-card border border-dashed px-4 py-3 text-sm ${
            stats.persistenceAvailable === false || stats.persistenceError
              ? 'border-amber-200 bg-amber-50/80 text-amber-900'
              : 'border-indigo-200 bg-indigo-50/50 text-indigo-800'
          }`}
        >
          <p>
            {stats.persistenceAvailable === false
              ? s.persistenceUnavailable
              : stats.persistenceError
                ? s.queryFailed.replace('{error}', stats.persistenceError)
                : s.emptyHistory}
          </p>
          {stats.dbPath ? (
            <p className="mt-2 break-all text-meta opacity-80">SQLite: {stats.dbPath}</p>
          ) : null}
        </div>
      )}

      {/* KPI row */}
      <div className="grid min-w-0 grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          icon={<TokenIcon />}
          iconClass="bg-violet-50 text-violet-600"
          label={s.kpiTotalTokens}
          value={formatTokenCount(k.totalTokens)}
          delta={k.deltas.totalTokens}
          vsLabel={vsLabel}
        />
        <KpiCard
          icon={<ClockIcon />}
          iconClass="bg-sky-50 text-sky-600"
          label={s.kpiTotalDuration}
          value={formatStatsDuration(k.totalDurationMs, locale)}
          delta={k.deltas.totalDurationMs}
          vsLabel={vsLabel}
        />
        <KpiCard
          icon={<FolderIcon />}
          iconClass="bg-emerald-50 text-emerald-600"
          label={s.kpiProjects}
          value={String(k.projectCount)}
          delta={k.deltas.projectCount}
          vsLabel={vsLabel}
          absolute
        />
        <KpiCard
          icon={<TokenIcon />}
          iconClass="bg-amber-50 text-amber-600"
          label={s.kpiAvgDailyTokens}
          value={formatTokenCount(k.avgDailyTokens)}
          delta={k.deltas.avgDailyTokens}
          vsLabel={vsLabel}
        />
        <KpiCard
          icon={<ClockIcon />}
          iconClass="bg-rose-50 text-rose-600"
          label={s.kpiAvgDailyDuration}
          value={formatStatsDuration(k.avgDailyDurationMs, locale)}
          delta={k.deltas.avgDailyDurationMs}
          vsLabel={vsLabel}
        />
        <KpiCard
          icon={<ChatIcon />}
          iconClass="bg-blue-50 text-blue-600"
          label={s.kpiDialogs}
          value={formatInt(k.dialogCount)}
          delta={k.deltas.dialogCount}
          vsLabel={vsLabel}
        />
      </div>

      {/* Trends + model + heatmap — min-w-0 prevents 30-day label rows from exploding width */}
      <div className="grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1.15fr)_minmax(0,0.9fr)]">
        <SurfaceCard
          title={s.tokenTrendTitle}
          action={<GranularityToggle value={granularity} labels={s} onChange={onGranularity} />}
        >
          <AreaTrendChart
            points={stats.tokenTrend}
            valueKey="tokens"
            color="#6366F1"
            formatValue={(n) => formatTokenCount(n)}
            locale={locale}
          />
        </SurfaceCard>

        <SurfaceCard
          title={s.durationTrendTitle}
          action={<GranularityToggle value={granularity} labels={s} onChange={onGranularity} />}
        >
          <AreaTrendChart
            points={stats.durationTrend.length ? stats.durationTrend : stats.tokenTrend}
            valueKey="durationMs"
            color="#34D399"
            formatValue={(n) => formatStatsDuration(n, locale)}
            locale={locale}
          />
        </SurfaceCard>

        <div className="flex min-w-0 flex-col gap-3">
          <SurfaceCard title={s.modelMixTitle}>
            <ModelDonut
              models={stats.models}
              otherLabel={s.otherModels}
              totalTokens={k.totalTokens}
            />
          </SurfaceCard>
          <SurfaceCard title={s.heatmapTitle}>
            <Heatmap cells={stats.heatmap} max={stats.heatmapMax} weekdayLabels={s.weekdayLabels} />
          </SurfaceCard>
        </div>
      </div>

      {/* Project rank + insights */}
      <div className="grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,0.9fr)]">
        <SurfaceCard title={s.projectRankTitle}>
          <ProjectTable stats={stats} s={s} locale={locale} />
        </SurfaceCard>
        <SurfaceCard title={s.insightsTitle}>
          <InsightsList insights={stats.insights} s={s} locale={locale} />
        </SurfaceCard>
      </div>

      {/* Bottom distributions */}
      <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SurfaceCard title={s.projectTypeTitle}>
          <CategoryDonut
            items={stats.projectTypes.map((p) => ({
              label: categoryLabel(p.labelKey, s),
              percent: p.percent,
              count: p.count,
            }))}
            centerLabel={String(k.projectCount)}
            centerHint={s.kpiProjects}
          />
        </SurfaceCard>
        <SurfaceCard title={s.fileTypeTitle}>
          <HorizontalBars
            items={stats.fileTypes.map((f) => ({
              label: f.key,
              percent: f.percent,
            }))}
            empty={s.noData}
          />
        </SurfaceCard>
        <SurfaceCard title={s.dialogBucketTitle}>
          <BucketBars buckets={stats.dialogTokenBuckets} s={s} />
        </SurfaceCard>
        <SurfaceCard title={s.efficiencyTitle}>
          <EfficiencyPanel efficiency={stats.efficiency} s={s} vsLabel={vsLabel} />
        </SurfaceCard>
      </div>
    </div>
  )
}

function KpiCard({
  icon,
  iconClass,
  label,
  value,
  delta,
  vsLabel,
  absolute,
}: {
  icon: ReactNode
  iconClass: string
  label: string
  value: string
  delta: StatsDelta
  vsLabel: string
  absolute?: boolean
}): JSX.Element {
  return (
    <div className="surface-card surface-card-hover min-w-0 px-3.5 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-meta text-ink-500">{label}</p>
          <p
            className="mt-1 truncate text-lg font-bold tracking-tight text-ink tabular-nums sm:text-xl"
            title={value}
          >
            {value}
          </p>
        </div>
        <span
          className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${iconClass}`}
        >
          {icon}
        </span>
      </div>
      <p className="mt-2 truncate text-[11px] font-medium">
        <DeltaText delta={delta} vsLabel={vsLabel} absolute={absolute} />
      </p>
    </div>
  )
}

function DeltaText({
  delta,
  vsLabel,
  absolute,
}: {
  delta: StatsDelta
  vsLabel: string
  absolute?: boolean
}): JSX.Element {
  if (!delta.comparable) {
    return <span className="text-ink-400">{vsLabel} —</span>
  }
  if (absolute && typeof delta.absolute === 'number') {
    const up = delta.absolute >= 0
    return (
      <span className={up ? 'text-emerald-600' : 'text-rose-600'}>
        {vsLabel} {up ? '+' : ''}
        {delta.absolute}
      </span>
    )
  }
  const ratio = delta.ratio ?? 0
  const up = ratio >= 0
  const pct = `${up ? '+' : ''}${(ratio * 100).toFixed(1)}%`
  return (
    <span className={up ? 'text-emerald-600' : 'text-rose-600'}>
      {vsLabel} {pct}
    </span>
  )
}

function SurfaceCard({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <section className="surface-card flex min-h-0 min-w-0 flex-col overflow-hidden p-4">
      <div className="mb-3 flex min-w-0 items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-semibold text-ink">{title}</h3>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
    </section>
  )
}

function GranularityToggle({
  value,
  labels,
  onChange,
}: {
  value: StatsTrendGranularity
  labels: StatsCopy
  onChange: (g: StatsTrendGranularity) => void
}): JSX.Element {
  return (
    <Segmented
      value={value}
      size="sm"
      options={[
        { value: 'day', label: labels.granularityDay },
        { value: 'week', label: labels.granularityWeek },
        { value: 'month', label: labels.granularityMonth },
      ]}
      onChange={(v) => onChange(v as StatsTrendGranularity)}
    />
  )
}

function Segmented({
  value,
  options,
  onChange,
  size = 'md',
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  size?: 'sm' | 'md'
}): JSX.Element {
  const pad = size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-meta'
  return (
    <div className="inline-flex rounded-badge border border-line bg-slate-50 p-0.5 shadow-soft">
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`rounded-[10px] font-semibold transition ${pad} ${
              active
                ? 'bg-white text-indigo-600 shadow-soft ring-1 ring-indigo-100'
                : 'text-ink-500 hover:text-ink'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

function AreaTrendChart({
  points,
  valueKey,
  color,
  formatValue,
}: {
  points: StatsTrendPoint[]
  valueKey: 'tokens' | 'durationMs'
  color: string
  formatValue: (n: number) => string
  locale: Locale
}): JSX.Element {
  const values = points.map((p) => (valueKey === 'tokens' ? p.tokens : p.durationMs))
  const max = Math.max(1, ...values)
  const w = 320
  const h = 140
  const padX = 8
  const padY = 16
  const n = Math.max(1, points.length)

  const coords = points.map((p, i) => {
    const x = padX + (i / Math.max(1, n - 1)) * (w - padX * 2)
    const v = valueKey === 'tokens' ? p.tokens : p.durationMs
    const y = h - padY - (v / max) * (h - padY * 2)
    return { x, y, p, v }
  })

  const line =
    coords.length === 0
      ? ''
      : coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ')
  const area =
    coords.length === 0
      ? ''
      : `${line} L ${coords[coords.length - 1]!.x.toFixed(1)} ${(h - padY).toFixed(1)} L ${coords[0]!.x.toFixed(1)} ${(h - padY).toFixed(1)} Z`

  const peak = coords.reduce(
    (best, c) => (c.v > best.v ? c : best),
    coords[0] ?? { x: 0, y: 0, p: points[0]!, v: 0 },
  )

  // 30 天按日时 thrash 所有标签会撑破卡片；只保留首尾 + 均匀抽样。
  const axisLabels = pickAxisLabels(points)
  const peakLeftPct = peak ? Math.min(92, Math.max(8, (peak.x / w) * 100)) : 50

  return (
    <div className="relative min-w-0 overflow-hidden">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-40 w-full max-w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id={`grad-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((t) => (
          <line
            key={t}
            x1={padX}
            x2={w - padX}
            y1={padY + t * (h - padY * 2)}
            y2={padY + t * (h - padY * 2)}
            stroke="#E6EBF5"
            strokeDasharray="4 4"
          />
        ))}
        {area && <path d={area} fill={`url(#grad-${color.replace('#', '')})`} stroke="none" />}
        {line && (
          <path d={line} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" />
        )}
        {peak && peak.v > 0 && (
          <circle cx={peak.x} cy={peak.y} r="4" fill={color} stroke="#fff" strokeWidth="2" />
        )}
      </svg>
      {peak && peak.v > 0 && (
        <div
          className="pointer-events-none absolute top-2 max-w-[9rem] -translate-x-1/2 rounded-lg border border-line bg-white px-2 py-1 text-[11px] shadow-soft"
          style={{ left: `${peakLeftPct}%` }}
        >
          <p className="truncate font-semibold text-ink">{peak.p.label}</p>
          <p className="truncate tabular-nums text-ink-500">{formatValue(peak.v)}</p>
        </div>
      )}
      <div className="relative mt-1 h-4 w-full overflow-hidden text-[10px] text-ink-400">
        {axisLabels.map((item) => {
          const left = n <= 1 ? 50 : (item.index / Math.max(1, n - 1)) * 100
          return (
            <span
              key={`${item.bucketStart}-${item.index}`}
              className="absolute top-0 -translate-x-1/2 tabular-nums whitespace-nowrap"
              style={{ left: `${left}%` }}
            >
              {item.label}
            </span>
          )
        })}
      </div>
    </div>
  )
}

/** Thin x-axis labels so 30 daily points never overflow the chart card. */
function pickAxisLabels(
  points: StatsTrendPoint[],
  maxLabels = 6,
): Array<{ label: string; index: number; bucketStart: number }> {
  const n = points.length
  if (n === 0) return []
  if (n <= maxLabels) {
    return points.map((p, index) => ({ label: p.label, index, bucketStart: p.bucketStart }))
  }
  const out: Array<{ label: string; index: number; bucketStart: number }> = []
  const last = n - 1
  for (let k = 0; k < maxLabels; k++) {
    const index = k === maxLabels - 1 ? last : Math.round((k * last) / (maxLabels - 1))
    if (out.some((item) => item.index === index)) continue
    const p = points[index]!
    out.push({ label: p.label, index, bucketStart: p.bucketStart })
  }
  return out
}

function ModelDonut({
  models,
  otherLabel,
  totalTokens,
}: {
  models: UsageStatsSnapshot['models']
  otherLabel: string
  totalTokens: number
}): JSX.Element {
  const top = models.slice(0, 3)
  const rest = models.slice(3)
  const restPct = rest.reduce((a, m) => a + m.percent, 0)
  const slices =
    restPct > 0
      ? [
          ...top,
          { model: otherLabel, tokens: rest.reduce((a, m) => a + m.tokens, 0), percent: restPct },
        ]
      : top

  const r = 42
  const cx = 56
  const cy = 56
  const circ = 2 * Math.PI * r
  let offset = 0
  const arcs = slices.map((slice, i) => {
    const len = (Math.max(0, slice.percent) / 100) * circ
    const dash = `${len} ${circ - len}`
    const item = {
      ...slice,
      color: MODEL_COLORS[i % MODEL_COLORS.length]!,
      dash,
      offset,
    }
    offset -= len
    return item
  })

  return (
    <div className="flex items-center gap-3">
      <div className="relative h-28 w-28 shrink-0">
        <svg viewBox="0 0 112 112" className="h-full w-full -rotate-90">
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="#EEF2F7" strokeWidth="14" />
          {arcs.length === 0
            ? null
            : arcs.map((a) => (
                <circle
                  key={a.model}
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill="none"
                  stroke={a.color}
                  strokeWidth="14"
                  strokeDasharray={a.dash}
                  strokeDashoffset={a.offset}
                  strokeLinecap="butt"
                />
              ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <p className="text-sm font-bold tabular-nums text-ink">
            {formatTokenCount(totalTokens || slices.reduce((a, m) => a + m.tokens, 0))}
          </p>
          <p className="text-[10px] text-ink-400">Token</p>
        </div>
      </div>
      <ul className="min-w-0 flex-1 space-y-1.5">
        {arcs.length === 0 ? (
          <li className="text-meta text-ink-400">—</li>
        ) : (
          arcs.map((a) => (
            <li key={a.model} className="flex items-center justify-between gap-2 text-meta">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: a.color }} />
                <span className="truncate font-medium text-ink-700">{a.model}</span>
              </span>
              <span className="shrink-0 tabular-nums font-semibold text-ink">
                {a.percent.toFixed(1)}%
              </span>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}

function Heatmap({
  cells,
  max,
  weekdayLabels,
}: {
  cells: UsageStatsSnapshot['heatmap']
  max: number
  weekdayLabels: string[]
}): JSX.Element {
  const byKey = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of cells) m.set(`${c.weekday}:${c.hour}`, c.value)
    return m
  }, [cells])

  return (
    <div className="min-w-0 overflow-hidden">
      <div className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] gap-1">
        <div />
        <div className="grid grid-cols-6 gap-0.5 text-[9px] text-ink-400">
          {[0, 4, 8, 12, 16, 20].map((h) => (
            <span key={h} className="text-center tabular-nums">
              {h}
            </span>
          ))}
        </div>
        {weekdayLabels.map((label, weekday) => (
          <div key={label} className="contents">
            <span className="self-center truncate text-[10px] text-ink-500">{label}</span>
            <div
              className="grid min-w-0 gap-0.5"
              style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}
            >
              {Array.from({ length: 24 }, (_, hour) => {
                const v = byKey.get(`${weekday}:${hour}`) ?? 0
                const t = max > 0 ? v / max : 0
                const bg =
                  t <= 0
                    ? '#EEF2F7'
                    : t < 0.25
                      ? '#C7D2FE'
                      : t < 0.5
                        ? '#818CF8'
                        : t < 0.75
                          ? '#6366F1'
                          : '#4338CA'
                return (
                  <div
                    key={hour}
                    title={`${label} ${hour}:00 — ${v}`}
                    className="aspect-square rounded-[2px]"
                    style={{ background: bg }}
                  />
                )
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-ink-400">
        <span>低</span>
        {['#EEF2F7', '#C7D2FE', '#818CF8', '#6366F1', '#4338CA'].map((c) => (
          <span key={c} className="h-2.5 w-2.5 rounded-sm" style={{ background: c }} />
        ))}
        <span>高</span>
      </div>
    </div>
  )
}

function ProjectTable({
  stats,
  s,
  locale,
}: {
  stats: UsageStatsSnapshot
  s: StatsCopy
  locale: Locale
}): JSX.Element {
  if (stats.projectRank.length === 0) {
    return <p className="py-6 text-center text-sm text-ink-400">{s.noData}</p>
  }
  const maxTokens = Math.max(1, ...stats.projectRank.map((p) => p.tokens))
  return (
    <div className="min-w-0 max-w-full overflow-x-auto">
      <table className="w-full min-w-[32rem] border-collapse text-left text-meta">
        <thead>
          <tr className="text-ink-400">
            <th className="pb-2 font-medium">{s.colRank}</th>
            <th className="pb-2 font-medium">{s.colProject}</th>
            <th className="pb-2 font-medium">{s.colTokens}</th>
            <th className="pb-2 font-medium">{s.colShare}</th>
            <th className="pb-2 font-medium">{s.colDuration}</th>
            <th className="pb-2 font-medium">{s.colDialogs}</th>
            <th className="pb-2 font-medium">{s.colLastActive}</th>
          </tr>
        </thead>
        <tbody>
          {stats.projectRank.map((row, i) => (
            <tr key={row.path} className="border-t border-line/80">
              <td className="py-2.5 tabular-nums text-ink-500">{i + 1}</td>
              <td className="py-2.5 font-semibold text-ink">
                <span className="block max-w-[10rem] truncate" title={row.path}>
                  {row.name}
                </span>
              </td>
              <td className="py-2.5">
                <div className="flex items-center gap-2">
                  <span className="w-14 tabular-nums font-semibold text-ink">
                    {formatTokenCount(row.tokens)}
                  </span>
                  <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-indigo-500"
                      style={{ width: `${Math.max(4, (row.tokens / maxTokens) * 100)}%` }}
                    />
                  </div>
                </div>
              </td>
              <td className="py-2.5 tabular-nums text-ink-700">{row.tokenShare.toFixed(1)}%</td>
              <td className="py-2.5 tabular-nums text-ink-700">
                {formatStatsDuration(row.durationMs, locale)}
              </td>
              <td className="py-2.5 tabular-nums text-ink-700">{row.dialogCount}</td>
              <td className="py-2.5 text-ink-500">
                {row.lastActiveAt ? formatRelative(row.lastActiveAt, Date.now(), locale) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function InsightsList({
  insights,
  s,
  locale,
}: {
  insights: StatsInsight[]
  s: StatsCopy
  locale: Locale
}): JSX.Element {
  const icons = ['peak', 'model', 'tip', 'info'] as const
  return (
    <ul className="space-y-2.5">
      {insights.map((insight, i) => {
        const title = fillTemplate(insightTitle(insight, s), insight.params, locale, s)
        const detail = fillTemplate(insightDetail(insight, s), insight.params, locale, s)
        return (
          <li
            key={insight.id}
            className="flex gap-2.5 rounded-badge border border-line bg-[#F8FAFC] px-3 py-2.5"
          >
            <span
              className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                i === 0
                  ? 'bg-emerald-50 text-emerald-600'
                  : i === 1
                    ? 'bg-amber-50 text-amber-600'
                    : 'bg-indigo-50 text-indigo-600'
              }`}
            >
              {icons[i % icons.length] === 'peak' ? (
                <TrendUpIcon />
              ) : icons[i % icons.length] === 'model' ? (
                <SparkIcon />
              ) : (
                <LightbulbIcon />
              )}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">{title}</p>
              <p className="mt-0.5 text-meta leading-5 text-ink-500">{detail}</p>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function CategoryDonut({
  items,
  centerLabel,
  centerHint,
}: {
  items: { label: string; percent: number; count: number }[]
  centerLabel: string
  centerHint: string
}): JSX.Element {
  const r = 36
  const cx = 48
  const cy = 48
  const circ = 2 * Math.PI * r
  let offset = 0
  const arcs = items.map((item, i) => {
    const len = (Math.max(0, item.percent) / 100) * circ
    const dash = `${len} ${circ - len}`
    const a = { ...item, color: TYPE_COLORS[i % TYPE_COLORS.length]!, dash, offset }
    offset -= len
    return a
  })

  return (
    <div className="flex items-center gap-3">
      <div className="relative h-24 w-24 shrink-0">
        <svg viewBox="0 0 96 96" className="h-full w-full -rotate-90">
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="#EEF2F7" strokeWidth="12" />
          {arcs.map((a) => (
            <circle
              key={a.label}
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke={a.color}
              strokeWidth="12"
              strokeDasharray={a.dash}
              strokeDashoffset={a.offset}
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <p className="text-base font-bold text-ink">{centerLabel}</p>
          <p className="text-[9px] text-ink-400">{centerHint}</p>
        </div>
      </div>
      <ul className="min-w-0 flex-1 space-y-1">
        {arcs.length === 0 ? (
          <li className="text-meta text-ink-400">—</li>
        ) : (
          arcs.map((a) => (
            <li key={a.label} className="flex items-center justify-between gap-2 text-meta">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: a.color }} />
                <span className="text-ink-700">{a.label}</span>
              </span>
              <span className="tabular-nums font-semibold">{a.percent.toFixed(1)}%</span>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}

function HorizontalBars({
  items,
  empty,
}: {
  items: { label: string; percent: number }[]
  empty: string
}): JSX.Element {
  if (items.length === 0) {
    return <p className="py-4 text-center text-meta text-ink-400">{empty}</p>
  }
  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.label}>
          <div className="mb-1 flex justify-between text-meta">
            <span className="font-medium text-ink-700">{item.label}</span>
            <span className="tabular-nums text-ink-500">{item.percent.toFixed(1)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-indigo-500"
              style={{ width: `${Math.max(2, item.percent)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

function BucketBars({
  buckets,
  s,
}: {
  buckets: UsageStatsSnapshot['dialogTokenBuckets']
  s: StatsCopy
}): JSX.Element {
  const max = Math.max(1, ...buckets.map((b) => b.count))
  return (
    <div className="flex h-36 items-end justify-between gap-2 px-1">
      {buckets.map((b) => {
        const h = Math.max(4, (b.count / max) * 100)
        const label = b.labelKey in s ? (s[b.labelKey as keyof StatsCopy] as string) : b.key
        return (
          <div key={b.key} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <span className="text-[10px] tabular-nums text-ink-400">{b.count || ''}</span>
            <div className="flex h-24 w-full items-end justify-center">
              <div
                className="w-full max-w-[2rem] rounded-t-md bg-indigo-400/90"
                style={{ height: `${h}%` }}
              />
            </div>
            <span className="w-full truncate text-center text-[10px] text-ink-500">{label}</span>
          </div>
        )
      })}
    </div>
  )
}

function EfficiencyPanel({
  efficiency,
  s,
  vsLabel,
}: {
  efficiency: UsageStatsSnapshot['efficiency']
  s: StatsCopy
  vsLabel: string
}): JSX.Element {
  const grade =
    efficiency.grade === 'excellent'
      ? s.gradeExcellent
      : efficiency.grade === 'good'
        ? s.gradeGood
        : efficiency.grade === 'fair'
          ? s.gradeFair
          : s.gradeLow
  const rows = [
    { label: s.scoreCodeGen, value: efficiency.codeGen },
    { label: s.scoreProblemSolve, value: efficiency.problemSolve },
    { label: s.scoreDialogQuality, value: efficiency.dialogQuality },
    { label: s.scoreFocus, value: efficiency.focus },
  ]
  const r = 36
  const circ = 2 * Math.PI * r
  const pct = Math.min(100, Math.max(0, efficiency.score)) / 100
  const dash = `${circ * pct} ${circ * (1 - pct)}`

  return (
    <div className="flex items-center gap-3">
      <div className="relative h-24 w-24 shrink-0">
        <svg viewBox="0 0 96 96" className="h-full w-full -rotate-90">
          <circle cx="48" cy="48" r={r} fill="none" stroke="#EEF2F7" strokeWidth="10" />
          <circle
            cx="48"
            cy="48"
            r={r}
            fill="none"
            stroke="#6366F1"
            strokeWidth="10"
            strokeDasharray={dash}
            strokeLinecap="round"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <p className="text-xl font-bold tabular-nums text-indigo-600">
            {efficiency.score || '—'}
          </p>
          <p className="text-[10px] font-semibold text-ink-500">{grade}</p>
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-2 text-meta">
            <span className="text-ink-500">{row.label}</span>
            <span className="tabular-nums font-semibold text-ink">{row.value || '—'}</span>
          </div>
        ))}
        <p className="pt-1 text-[11px]">
          <DeltaText delta={efficiency.delta} vsLabel={vsLabel} absolute />
        </p>
      </div>
    </div>
  )
}

function categoryLabel(key: string, s: StatsCopy): string {
  if (key === 'projectTypeTool') return s.projectTypeTool
  if (key === 'projectTypeResearch') return s.projectTypeResearch
  if (key === 'projectTypeWeb') return s.projectTypeWeb
  if (key === 'projectTypeOther') return s.projectTypeOther
  return key
}

function insightTitle(insight: StatsInsight, s: StatsCopy): string {
  const map: Record<string, string> = {
    insightPeakDay: s.insightPeakDay,
    insightTopModel: s.insightTopModel,
    insightEfficiency: s.insightEfficiency,
    insightPeakHour: s.insightPeakHour,
    insightEmpty: s.insightEmpty,
  }
  return map[insight.titleKey] ?? insight.titleKey
}

function insightDetail(insight: StatsInsight, s: StatsCopy): string {
  const map: Record<string, string> = {
    insightPeakDayDetail: s.insightPeakDayDetail,
    insightTopModelDetail: s.insightTopModelDetail,
    insightEfficiencyDetail: s.insightEfficiencyDetail,
    insightPeakHourDetail: s.insightPeakHourDetail,
    insightEmptyDetail: s.insightEmptyDetail,
  }
  return map[insight.detailKey] ?? insight.detailKey
}

function fillTemplate(
  template: string,
  params: Record<string, string | number>,
  _locale: Locale,
  s: StatsCopy,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = params[key]
    if (v == null) return ''
    if (key === 'tokens' || key === 'avgTokens') return formatTokenCount(Number(v))
    if (key === 'percent') return `${v}%`
    if (key === 'weekday') {
      const idx = Number(v)
      return s.weekdayLabels[idx] ?? String(v)
    }
    return String(v)
  })
}

function formatStatsDuration(ms: number, locale: Locale): string {
  if (!ms || ms < 0) return locale === 'zh' ? '0m' : '0m'
  const totalMin = Math.floor(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h > 0) return locale === 'zh' ? `${h}h ${m}m` : `${h}h ${m}m`
  if (m > 0) return `${m}m`
  const sec = Math.max(1, Math.floor(ms / 1000))
  return `${sec}s`
}

function formatInt(n: number): string {
  return new Intl.NumberFormat('en-US').format(n)
}

function formatRangeLabel(start: number, end: number): string {
  const fmt = (ts: number): string => {
    const d = new Date(ts)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
  // end is exclusive; show last inclusive day
  return `${fmt(start)} ~ ${fmt(end - 1)}`
}

function CalendarIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 opacity-70" aria-hidden>
      <path
        fill="currentColor"
        d="M4 2a1 1 0 00-1 1v1H2.5A1.5 1.5 0 001 5.5v7A1.5 1.5 0 002.5 14h11a1.5 1.5 0 001.5-1.5v-7A1.5 1.5 0 0013.5 4H13V3a1 1 0 10-2 0v1H5V3a1 1 0 00-1-1zm-1.5 5h11v5.5a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5V7z"
      />
    </svg>
  )
}

function RefreshIcon({ spin }: { spin?: boolean }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-3.5 w-3.5 opacity-70 ${spin ? 'animate-spin' : ''}`}
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M13.5 8A5.5 5.5 0 113 5.7V4a.75.75 0 00-1.5 0v3c0 .4.3.75.75.75h3a.75.75 0 000-1.5H3.6A4 4 0 1012 8a.75.75 0 001.5 0z"
      />
    </svg>
  )
}

function SparkIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
      <path
        fill="currentColor"
        d="M8 1l1.2 3.8L13 6l-3.8 1.2L8 11l-1.2-3.8L3 6l3.8-1.2L8 1zm4.5 7l.7 2.2 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.2z"
      />
    </svg>
  )
}

function TokenIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
      <path
        fill="currentColor"
        d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 2.5c1.8 0 3.3 1 4.1 2.5H5.9A4.7 4.7 0 0110 4.5zM5.2 10c0-.5.1-1 .2-1.5h9.2c.1.5.2 1 .2 1.5s-.1 1-.2 1.5H5.4c-.1-.5-.2-1-.2-1.5zm.7 3h8.2A4.7 4.7 0 0110 15.5 4.7 4.7 0 015.9 13z"
      />
    </svg>
  )
}

function ClockIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
      <path
        fill="currentColor"
        d="M10 2a8 8 0 100 16 8 8 0 000-16zm.75 4a.75.75 0 00-1.5 0v4.1c0 .2.08.39.22.53l2.5 2.5a.75.75 0 001.06-1.06l-2.28-2.28V6z"
      />
    </svg>
  )
}

function FolderIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
      <path
        fill="currentColor"
        d="M2 5.5A1.5 1.5 0 013.5 4H7l1.5 1.5H16.5A1.5 1.5 0 0118 7v7.5a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 012 14.5v-9z"
      />
    </svg>
  )
}

function ChatIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
      <path
        fill="currentColor"
        d="M3 4.5A1.5 1.5 0 014.5 3h11A1.5 1.5 0 0117 4.5v7A1.5 1.5 0 0115.5 13H8l-3.5 3.2c-.5.45-1.3.1-1.3-.55V4.5z"
      />
    </svg>
  )
}

function TrendUpIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
      <path
        fill="currentColor"
        d="M2 12l4-4 2.5 2.5L13 5.5V8h1.5V3.5H10V5h2.3L8.5 9.3 6 6.8 1 12h1z"
      />
    </svg>
  )
}

function LightbulbIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
      <path
        fill="currentColor"
        d="M8 1a5 5 0 00-3 9v1.5c0 .8.7 1.5 1.5 1.5h3c.8 0 1.5-.7 1.5-1.5V10a5 5 0 00-3-9zM6.5 14h3v.5a.5.5 0 01-.5.5h-2a.5.5 0 01-.5-.5V14z"
      />
    </svg>
  )
}
