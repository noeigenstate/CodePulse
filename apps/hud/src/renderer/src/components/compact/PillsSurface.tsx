import { useEffect, useState, type CSSProperties } from 'react'
import { isUrgent, type CompactTask } from '../../lib/hudCompact.js'
import { turnStateLabel } from '../../lib/i18n.js'
import { SurfaceControls } from '../SurfaceControls.js'
import { StateMark } from './StateMark.js'
import { TaskActions, UsageLine, taskMetrics, taskSource, toggleOnBackground } from './TaskRow.js'
import type { ListProps, SurfaceProps } from './types.js'

/** `null` means the user folded the pill that would otherwise open on its own. */
type Choice = { auto: string | undefined; id: string | null }

function TaskPill({
  big,
  list,
  onToggle,
  task,
}: {
  big: boolean
  list: ListProps
  onToggle: () => void
  task: CompactTask
}): JSX.Element {
  const { copy, locale, now, onAck, onDismiss } = list
  const state = turnStateLabel(task.card.agent.state, locale)
  const mini = task.level === 'quiet' && !big
  const style = {
    '--pc': task.level === 'fault' ? 'var(--c-fault)' : 'var(--c-action)',
  } as CSSProperties
  return (
    <div
      className={`hud-c-pill hud-c-surface is-${task.level}${big ? ' is-big' : ''}${
        mini ? ' is-mini' : ''
      }${big && isUrgent(task) ? ' hud-c-urgent' : ''}`}
      data-hud-hit=""
      onClick={toggleOnBackground(onToggle)}
      style={style}
      title={mini ? `${task.title} · ${state}` : undefined}
    >
      <button
        aria-expanded={big}
        aria-label={`${task.title}, ${state}`}
        className="hud-c-fill"
        onClick={onToggle}
        type="button"
      />
      <div className="hud-c-pill-one">
        <StateMark level={task.level} />
        <span className="hud-c-title" title={task.title}>
          {task.title}
        </span>
        <span className="hud-c-state">{state}</span>
      </div>
      <div className="hud-c-pill-more">
        <span className="hud-c-lines">
          <span className="hud-c-meta">{taskSource(task)}</span>
          <span className="hud-c-meta">{taskMetrics(task, now, locale)}</span>
        </span>
        <TaskActions copy={copy} onAck={onAck} onDismiss={onDismiss} task={task} />
      </div>
    </div>
  )
}

/**
 * One pill per task in the deck's stable order; the most urgent one grows into a card.
 * `open` (preview only) grows every pill.
 */
export function PillsSurface({
  collapseTick,
  list,
  open,
  peek,
}: SurfaceProps & { collapseTick: number }): JSX.Element {
  const { copy, locale, tasks } = list
  const autoId = peek?.card.id
  const [choice, setChoice] = useState<Choice>()
  const folded = choice?.auto === autoId ? choice : undefined
  const bigId = folded ? folded.id : autoId
  // Escape or a lost focus folds whatever is open.
  useEffect(() => {
    if (collapseTick > 0) setChoice({ auto: autoId, id: null })
    // Only a new collapse request matters; a changing alert already resets the choice.
  }, [collapseTick])

  const toggle = (id: string): void => setChoice({ auto: autoId, id: bigId === id ? null : id })

  return (
    <div className="hud-c-stack" role="group" aria-label={copy.compact.stackLabel}>
      {tasks.length === 0 ? (
        <div
          className="hud-c-pill hud-c-surface is-quiet is-mini"
          data-hud-hit=""
          title={`${
            list.allToolsHidden
              ? copy.emptyDashboard.settingsHiddenTitle
              : copy.emptyDashboard.title
          }`}
        >
          <div className="hud-c-pill-one">
            <StateMark level="quiet" />
            <span className="hud-c-title">{copy.compact.idle}</span>
          </div>
        </div>
      ) : (
        tasks.map((task) => (
          <TaskPill
            big={open || bigId === task.card.id}
            key={task.card.id}
            list={list}
            onToggle={() => toggle(task.card.id)}
            task={task}
          />
        ))
      )}
      {list.showUsageStrip ? (
        <div className="hud-c-usage-pill hud-c-surface" data-hud-hit="">
          <UsageLine list={list} />
        </div>
      ) : null}
      <div className="hud-c-controls-pill hud-c-surface" data-hud-hit="">
        <SurfaceControls compact locale={locale} />
      </div>
    </div>
  )
}
