import { useLayoutEffect, useMemo, useRef } from 'react'
import {
  TurnState,
  formatTokenCount,
  formatTokenPercent,
  type AgentRuntimeState,
  type AgentType,
} from '@codepulse/shared'
import type { AgentPanel } from '../lib/displayAgents.js'
import { formatDuration, formatRelative } from '../lib/format.js'
import { hudStateLevel } from '../lib/hudState.js'
import { acknowledgementLabel, turnStateLabel, type Locale, type UiCopy } from '../lib/i18n.js'
import {
  buildProjectDeckGroups,
  buildProjectUsageSummaries,
  projectSourceLabel,
  type ProjectDeckCard,
  type ProjectDeckGroup,
  type ProjectUsageSummary,
} from '../lib/projectDeck.js'
import { useNow } from '../lib/useNow.js'
import type { HudProjectLayout } from '../lib/dashboardSettings.js'

interface Props {
  allToolsHidden: boolean
  copy: UiCopy
  layout: HudProjectLayout
  locale: Locale
  onAck: (agentType: AgentType, workspacePath?: string) => void
  panels: AgentPanel[]
  showUsageStrip: boolean
}

/** Compact project-first HUD. There are no provider containers or provider-local scroll areas. */
export function ProjectDeck({
  allToolsHidden,
  copy,
  layout,
  locale,
  onAck,
  panels,
  showUsageStrip,
}: Props): JSX.Element {
  const shellRef = useRef<HTMLDivElement>(null)
  const lastReportedHeight = useRef(0)
  const now = useNow(30_000)
  const groups = useMemo(() => buildProjectDeckGroups(panels), [panels])
  const usage = useMemo(() => buildProjectUsageSummaries(panels), [panels])

  useLayoutEffect(() => {
    const shell = shellRef.current
    if (!shell) return

    const reportNaturalHeight = (): void => {
      const header = shell.querySelector<HTMLElement>('.project-deck-header')
      const content = shell.querySelector<HTMLElement>('.project-deck-grid, .project-deck-empty')
      const footer = shell.querySelector<HTMLElement>('.project-deck-usage')
      const bodyStyle = window.getComputedStyle(document.body)
      const bodyInsets =
        parseFloat(bodyStyle.paddingTop || '0') + parseFloat(bodyStyle.paddingBottom || '0')
      // The app shell's own border shrinks its content box; without it the
      // viewport overflows by the border width and shows a phantom scrollbar.
      const appShell = shell.closest('.app-shell')
      const appShellStyle = appShell ? window.getComputedStyle(appShell) : undefined
      const shellBorder = appShellStyle
        ? parseFloat(appShellStyle.borderTopWidth || '0') +
          parseFloat(appShellStyle.borderBottomWidth || '0')
        : 0
      const height = Math.ceil(
        (header?.getBoundingClientRect().height ?? 0) +
          (content?.scrollHeight ?? 0) +
          (footer?.getBoundingClientRect().height ?? 0) +
          bodyInsets +
          shellBorder,
      )
      if (height <= 0 || height === lastReportedHeight.current) return
      lastReportedHeight.current = height
      void window.codepulse.setHudContentHeight(height)
    }

    const observer = new ResizeObserver(reportNaturalHeight)
    for (const element of shell.children) observer.observe(element)
    const frame = window.requestAnimationFrame(reportNaturalHeight)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [allToolsHidden, groups, layout, showUsageStrip])

  return (
    <div className="project-deck-shell min-h-0 flex-1" ref={shellRef}>
      <header className="project-deck-header">
        <div className="project-deck-brand" aria-label="CodePulse">
          <span className="project-deck-signal" aria-hidden="true" />
          <span>CODEPULSE</span>
        </div>
      </header>

      <main className="project-deck-viewport">
        {groups.length === 0 ? (
          <div className="project-deck-empty" role="status">
            <strong>
              {allToolsHidden ? copy.emptyDashboard.settingsHiddenTitle : copy.emptyDashboard.title}
            </strong>
            <span>
              {allToolsHidden ? copy.emptyDashboard.settingsHiddenBody : copy.emptyDashboard.body}
            </span>
          </div>
        ) : (
          <div className="project-deck-grid" data-layout={layout}>
            {groups.map((group) => (
              <section
                className="project-deck-group"
                data-multi={group.cards.length > 1 ? '' : undefined}
                key={group.id}
              >
                {group.cards.map((card) => (
                  <ProjectDeckCard
                    card={card}
                    copy={copy}
                    group={group}
                    key={card.id}
                    locale={locale}
                    now={now}
                    onAck={onAck}
                  />
                ))}
              </section>
            ))}
          </div>
        )}
      </main>

      {showUsageStrip ? <UsageStrip locale={locale} usage={usage} /> : null}
    </div>
  )
}

function ProjectDeckCard({
  card,
  copy,
  group,
  locale,
  now,
  onAck,
}: {
  card: ProjectDeckCard
  copy: UiCopy
  group: ProjectDeckGroup
  locale: Locale
  now: number
  onAck: (agentType: AgentType, workspacePath?: string) => void
}): JSX.Element {
  // Every card owns exactly one agent: state, timer, context, and the
  // acknowledgement button are fully independent from its project siblings.
  const agent = card.agent
  const level = hudStateLevel(agent)
  const elapsed = elapsedMs(agent, now)
  const contextLabel = formatContextLabel(agent, locale)

  return (
    <article className="project-deck-item" data-hud-level={level}>
      <div className="project-deck-item-main">
        <span className="project-deck-source">{projectSourceLabel(card.agentType)}</span>
        <h2 title={group.workspacePath}>{group.name || copy.unknownProject}</h2>
        {group.workspacePath ? (
          <span className="project-deck-path" title={group.workspacePath}>
            {group.workspacePath}
          </span>
        ) : null}
      </div>

      <span className="project-deck-state">
        <span className={`project-deck-state-dot is-${level}`} aria-hidden="true" />
        {turnStateLabel(agent.state, locale)}
      </span>

      <div className="project-deck-metrics">
        <span className="project-deck-elapsed">
          {elapsed != null
            ? formatDuration(elapsed, locale)
            : formatRelative(card.updatedAt, now, locale)}
        </span>
        {contextLabel ? (
          <span className="project-deck-context" title={contextLabel}>
            {contextLabel}
          </span>
        ) : null}
      </div>

      <div className="project-deck-ack-slot">
        {agent.unread ? (
          <button
            className="project-deck-ack"
            onClick={() => onAck(card.agentType, group.workspacePath)}
            type="button"
          >
            {acknowledgementLabel(agent.state, Boolean(group.workspacePath), copy)}
          </button>
        ) : null}
      </div>
    </article>
  )
}

function UsageStrip({
  locale,
  usage,
}: {
  locale: Locale
  usage: ProjectUsageSummary[]
}): JSX.Element {
  return (
    <footer className="project-deck-usage">
      <span className="project-deck-usage-label">{locale === 'zh' ? '用量' : 'Usage'}</span>
      {usage.length > 0 ? (
        usage.map((item) => (
          <span key={item.agentType}>
            {item.label} {formatUsageWindows(item, locale)}
          </span>
        ))
      ) : (
        <span>—</span>
      )}
    </footer>
  )
}

/** Renders `5小时 23% 周 11%` when both quota windows exist, or a bare percent for one. */
function formatUsageWindows(item: ProjectUsageSummary, locale: Locale): string {
  const fiveHour =
    item.fiveHourPercent != null
      ? `${locale === 'zh' ? '5小时' : '5h'} ${formatTokenPercent(item.fiveHourPercent)}`
      : undefined
  const sevenDay =
    item.sevenDayPercent != null
      ? `${item.fiveHourPercent != null ? `${locale === 'zh' ? '周' : 'wk'} ` : ''}${formatTokenPercent(item.sevenDayPercent)}`
      : undefined
  return [fiveHour, sevenDay].filter(Boolean).join(' ')
}

/**
 * Compact context readout like `43% (109k/256k)`: used percent plus absolute
 * tokens when the agent reports its context window size.
 */
function formatContextLabel(agent: AgentRuntimeState, locale: Locale): string | undefined {
  const contextUsed = normalizedPercent(agent.token?.contextUsedPercent)
  if (contextUsed == null) return undefined
  const usedPercent = Math.round(contextUsed)
  const window = agent.token?.contextWindow
  if (window == null || !Number.isFinite(window) || window <= 0) {
    return locale === 'zh' ? `上下文 ${usedPercent}%` : `Context ${usedPercent}%`
  }
  const usedTokens = Math.round((contextUsed / 100) * window)
  return `${usedPercent}% (${formatTokenCount(usedTokens)}/${formatTokenCount(window)})`
}

function elapsedMs(agent: AgentRuntimeState, now: number): number | undefined {
  if (agent.turnTiming?.state === 'completed' && agent.turnTiming.elapsedMs != null) {
    return Math.max(0, agent.turnTiming.elapsedMs)
  }
  const startedAt = agent.turnTiming?.startedAt ?? agent.turnStartedAt
  if (startedAt != null && isActiveTurn(agent.state)) return Math.max(0, now - startedAt)
  return agent.turnTiming?.elapsedMs
}

function isActiveTurn(state: TurnState): boolean {
  return (
    state === TurnState.PROMPT_SUBMITTED ||
    state === TurnState.THINKING ||
    state === TurnState.TOOL_RUNNING ||
    state === TurnState.WAITING_PERMISSION ||
    state === TurnState.WAITING_USER_INPUT
  )
}

function normalizedPercent(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined
  return clampPercent(value)
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}
