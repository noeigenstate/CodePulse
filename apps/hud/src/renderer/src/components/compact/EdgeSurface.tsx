import type { CSSProperties } from 'react'
import { isUrgent } from '../../lib/hudCompact.js'
import { turnStateLabel } from '../../lib/i18n.js'
import { StateMark } from './StateMark.js'
import { PeekText, TaskList, useLastDefined, useMeasuredHeight } from './TaskRow.js'
import type { SurfaceProps } from './types.js'

const DRAWER_MAX_HEIGHT = 420

/** A narrow tab on the right edge: one mark per task, a one-line peek and a drawer. */
export function EdgeSurface({ list, onToggle, open, peek }: SurfaceProps): JSX.Element {
  const { copy, locale, tasks } = list
  const [measureRef, listHeight] = useMeasuredHeight()
  const peeking = Boolean(peek) && !open
  const shownPeek = useLastDefined(peek)
  const style = {
    '--pc': peek?.level === 'fault' ? 'var(--c-fault)' : 'var(--c-action)',
  } as CSSProperties
  const drawerStyle = { height: Math.min(listHeight, DRAWER_MAX_HEIGHT) } as CSSProperties

  return (
    <div className="hud-c-edge" style={style}>
      <div
        className={`hud-c-bubble hud-c-surface${peeking ? ' is-on' : ''}`}
        data-hud-hit=""
        onClick={peeking ? onToggle : undefined}
      >
        {shownPeek ? (
          <div className="hud-c-bubble-in">
            <PeekText copy={copy} locale={locale} others={tasks.length - 1} task={shownPeek} />
          </div>
        ) : null}
      </div>
      <div
        className={`hud-c-drawer hud-c-surface${open ? ' is-on' : ''}`}
        data-hud-hit=""
        style={drawerStyle}
      >
        <div className="hud-c-scroll">
          <div ref={measureRef} className="hud-c-measure">
            <TaskList list={list} />
          </div>
        </div>
      </div>
      <button
        aria-expanded={open}
        aria-label={`${copy.compact.edgeLabel}: ${open ? copy.compact.closeList : copy.compact.openList}`}
        className={`hud-c-tab hud-c-surface${isUrgent(peek) && !open ? ' hud-c-urgent' : ''}`}
        data-hud-hit=""
        onClick={onToggle}
        type="button"
      >
        {tasks.length > 0 ? (
          tasks.map((task) => (
            <span
              className="hud-c-tab-item"
              key={task.card.id}
              title={`${task.title} · ${turnStateLabel(task.card.agent.state, locale)}`}
            >
              <StateMark level={task.level} />
              <span className="hud-c-sr">
                {task.title}, {turnStateLabel(task.card.agent.state, locale)}
              </span>
            </span>
          ))
        ) : (
          <span className="hud-c-tab-item" title={copy.compact.idle}>
            <StateMark level="quiet" />
            <span className="hud-c-sr">{copy.compact.idle}</span>
          </span>
        )}
      </button>
    </div>
  )
}
