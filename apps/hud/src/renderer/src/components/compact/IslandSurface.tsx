import type { CSSProperties } from 'react'
import { islandBox, isUrgent } from '../../lib/hudCompact.js'
import { StateMark } from './StateMark.js'
import {
  PeekText,
  TaskActions,
  TaskList,
  fill,
  toggleOnBackground,
  useLastDefined,
  useMeasuredHeight,
} from './TaskRow.js'
import type { SurfaceProps } from './types.js'

function CollapsedText({ list, summary }: Pick<SurfaceProps, 'list' | 'summary'>): JSX.Element {
  const { compact } = list.copy
  const parts: string[] = []
  if (summary.running > 0) parts.push(fill(compact.running, summary.running))
  if (summary.unread > 0) parts.push(fill(compact.unread, summary.unread))
  return (
    <>
      <StateMark level={summary.running > 0 ? 'active' : summary.unread > 0 ? 'notice' : 'quiet'} />
      <span className="hud-c-strong">{parts.length > 0 ? parts.join(' · ') : compact.idle}</span>
    </>
  )
}

/** A pill at the top centre that morphs between idle, peek and the full task list. */
export function IslandSurface(props: SurfaceProps): JSX.Element {
  const { list, onToggle, open, peek } = props
  const [measureRef, listHeight] = useMeasuredHeight()
  const peeking = Boolean(peek) && !open
  const shownPeek = useLastDefined(peek)
  const size = islandBox({ open, peeking, summary: props.summary, listHeight })
  const urgent = isUrgent(peek) && !open
  const style = {
    width: size.width,
    height: size.height,
    borderRadius: size.radius,
    '--pc': peek?.level === 'fault' ? 'var(--c-fault)' : 'var(--c-action)',
  } as CSSProperties
  const toggleLabel = `${list.copy.compact.hud}: ${
    open ? list.copy.compact.closeList : list.copy.compact.openList
  }`

  return (
    <div
      className={`hud-c-island hud-c-surface${urgent ? ' hud-c-urgent' : ''}`}
      data-hud-hit=""
      onClick={toggleOnBackground(onToggle)}
      style={style}
    >
      <button
        aria-expanded={open}
        aria-label={toggleLabel}
        className="hud-c-fill"
        onClick={onToggle}
        type="button"
      />
      <div className={`hud-c-pane is-collapsed${!open && !peeking ? ' is-on' : ''}`}>
        <div className="hud-c-collapsed">
          <CollapsedText list={list} summary={props.summary} />
        </div>
      </div>
      <div className={`hud-c-pane is-peek${peeking ? ' is-on' : ''}`}>
        {shownPeek ? (
          <div className="hud-c-peek">
            <PeekText
              copy={list.copy}
              locale={list.locale}
              others={list.tasks.length - 1}
              task={shownPeek}
            />
            <TaskActions
              copy={list.copy}
              onAck={list.onAck}
              onDismiss={list.onDismiss}
              task={shownPeek}
            />
          </div>
        ) : null}
      </div>
      <div className={`hud-c-pane is-list${open ? ' is-on' : ''}`}>
        <div className="hud-c-scroll">
          <div ref={measureRef} className="hud-c-measure">
            <TaskList list={list} />
          </div>
        </div>
      </div>
    </div>
  )
}
