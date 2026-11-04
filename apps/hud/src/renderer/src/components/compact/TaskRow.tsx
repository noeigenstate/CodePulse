import { useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react'
import { formatDuration, formatRelative } from '../../lib/format.js'
import type { CompactTask } from '../../lib/hudCompact.js'
import { acknowledgementLabel, turnStateLabel, type Locale, type UiCopy } from '../../lib/i18n.js'
import { projectSourceLabel } from '../../lib/projectDeck.js'
import { elapsedMs, formatContextLabel, formatUsageWindows } from '../../lib/projectDeckFormat.js'
import { SurfaceControls } from '../SurfaceControls.js'
import { StateMark } from './StateMark.js'
import type { AckHandler, ListProps } from './types.js'

/** Fills a `{n}` placeholder in a compact copy string. */
export function fill(template: string, n: number): string {
  return template.replace('{n}', String(n))
}

/** `5m 03s · 31%`: elapsed (or time since the last change) plus the context percent. */
export function taskMetrics(task: CompactTask, now: number, locale: Locale): string {
  const { card } = task
  const elapsed = elapsedMs(card.agent, now)
  const time =
    elapsed != null ? formatDuration(elapsed, locale) : formatRelative(card.updatedAt, now, locale)
  const context = formatContextLabel(card.agent, locale)?.match(/\d+%/)?.[0]
  return context ? `${time} · ${context}` : time
}

/** `CLAUDE · E:/path`: the agent and, when known, its project directory. */
export function taskSource(task: CompactTask): string {
  const path = task.group.workspacePath
  const source = projectSourceLabel(task.card.agentType)
  return path ? `${source} · ${path}` : source
}

/** Clicks on a surface's background toggle it; buttons inside keep their own action. */
export function toggleOnBackground(onToggle: () => void): (event: MouseEvent) => void {
  return (event) => {
    if (!(event.target as Element).closest('button, a, input')) onToggle()
  }
}

/** Measures the natural height of a child that is clipped by an animated frame. */
export function useMeasuredHeight(): [RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = (): void => setHeight(Math.ceil(element.offsetHeight))
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [])
  return [ref, height]
}

export function TaskActions({
  copy,
  onAck,
  onDismiss,
  task,
}: {
  copy: UiCopy
  onAck: AckHandler
  onDismiss: AckHandler
  task: CompactTask
}): JSX.Element {
  const { card, group, title } = task
  const source = projectSourceLabel(card.agentType)
  return (
    <span className="hud-c-actions">
      {card.agent.unread ? (
        <button
          className="hud-c-act is-read"
          onClick={() => onAck(card.agentType, group.workspacePath, card.agent.externalSessionId)}
          type="button"
        >
          {acknowledgementLabel(card.agent.state, Boolean(group.workspacePath), copy)}
        </button>
      ) : null}
      <button
        aria-label={`${copy.dismissProjectCard}: ${title} · ${source}`}
        className="hud-c-act"
        onClick={() => onDismiss(card.agentType, group.workspacePath, card.agent.externalSessionId)}
        title={copy.dismissProjectCard}
        type="button"
      >
        <svg aria-hidden="true" className="hud-c-x" viewBox="0 0 12 12">
          <path d="M2.25 2.25 9.75 9.75M9.75 2.25 2.25 9.75" />
        </svg>
      </button>
    </span>
  )
}

function TaskRow({ list, task }: { list: ListProps; task: CompactTask }): JSX.Element {
  const { copy, locale, now, onAck, onDismiss } = list
  const state = turnStateLabel(task.card.agent.state, locale)
  return (
    <li className={`hud-c-row is-${task.level}`}>
      <StateMark level={task.level} />
      <div className="hud-c-text">
        <div className="hud-c-title" title={task.title}>
          {task.title}
        </div>
        <div className="hud-c-meta" title={task.group.workspacePath}>
          {taskSource(task)}
        </div>
      </div>
      <div className="hud-c-side">
        <span className="hud-c-side-text">
          <span className="hud-c-state">{state}</span>
          <span className="hud-c-meta">{taskMetrics(task, now, locale)}</span>
        </span>
        <TaskActions copy={copy} onAck={onAck} onDismiss={onDismiss} task={task} />
      </div>
    </li>
  )
}

/** One line about the task a collapsed surface is announcing. */
export function PeekText({
  copy,
  locale,
  others,
  task,
}: {
  copy: UiCopy
  locale: Locale
  others: number
  task: CompactTask
}): JSX.Element {
  const state = turnStateLabel(task.card.agent.state, locale)
  const parts = [projectSourceLabel(task.card.agentType), state]
  if (others > 0) parts.push(fill(copy.compact.more, others))
  return (
    <>
      <StateMark level={task.level} />
      <span className="hud-c-text">
        <span className="hud-c-title" title={task.title}>
          {task.title}
        </span>
        <span className="hud-c-meta">{parts.join(' · ')}</span>
      </span>
    </>
  )
}

export function UsageLine({ list }: { list: ListProps }): JSX.Element {
  const { copy, locale, usage } = list
  return (
    <div className="hud-c-usage">
      <span>{copy.compact.usage}</span>
      {usage.length > 0 ? (
        usage.map((item) => (
          <span key={item.agentType}>
            <b>{item.label}</b> {formatUsageWindows(item, locale)}
          </span>
        ))
      ) : (
        <span>—</span>
      )}
    </div>
  )
}

/** Open list shared by the island, drawer and orb popup. Order is the deck's own. */
export function TaskList({ list }: { list: ListProps }): JSX.Element {
  const { allToolsHidden, copy, locale, tasks } = list
  const empty = allToolsHidden ? copy.emptyDashboard.settingsHiddenTitle : copy.emptyDashboard.title
  const emptyBody = allToolsHidden
    ? copy.emptyDashboard.settingsHiddenBody
    : copy.emptyDashboard.body
  return (
    <div className="hud-c-list">
      {tasks.length === 0 ? (
        <div className="hud-c-empty" role="status">
          <StateMark level="quiet" />
          <span className="hud-c-text">
            <span className="hud-c-title">{empty}</span>
            <span className="hud-c-meta is-wrap">{emptyBody}</span>
          </span>
        </div>
      ) : (
        <ul>
          {tasks.map((task) => (
            <TaskRow key={task.card.id} list={list} task={task} />
          ))}
        </ul>
      )}
      {list.showUsageStrip ? <UsageLine list={list} /> : null}
      <div className="hud-c-controls">
        <SurfaceControls compact locale={locale} />
      </div>
    </div>
  )
}
