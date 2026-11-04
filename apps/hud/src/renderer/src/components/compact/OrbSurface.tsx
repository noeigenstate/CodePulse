import { useRef, type CSSProperties, type PointerEvent } from 'react'
import { isUrgent, type CompactTask } from '../../lib/hudCompact.js'
import { PeekText, TaskList, fill, useMeasuredHeight } from './TaskRow.js'
import type { OrbProps } from './types.js'

const DRAG_THRESHOLD = 4
const POP_MAX_HEIGHT = 392
const RADIUS = 25
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** One arc per task, coloured by level; a lone quiet ring when there is nothing to show. */
function Ring({ tasks }: { tasks: CompactTask[] }): JSX.Element {
  const levels = tasks.length > 0 ? tasks.map((task) => task.level) : (['quiet'] as const)
  const count = levels.length
  const segment = CIRCUMFERENCE / count
  const gap = count > 1 ? Math.min(4, segment * 0.4) : 0
  return (
    <svg aria-hidden="true" className="hud-c-ring" height="56" viewBox="0 0 56 56" width="56">
      {levels.map((level, index) => (
        <circle
          className={`hud-c-arc is-${level}`}
          cx="28"
          cy="28"
          fill="none"
          key={index}
          r={RADIUS}
          strokeDasharray={`${segment - gap} ${CIRCUMFERENCE - (segment - gap)}`}
          strokeDashoffset={-(index * segment)}
          strokeLinecap="butt"
          strokeWidth="4"
          transform="rotate(-90 28 28)"
        />
      ))}
    </svg>
  )
}

/** A draggable ball whose ring shows every task; the bubble and list open toward the screen centre. */
export function OrbSurface({
  bridge,
  hit,
  list,
  onToggle,
  open,
  peek,
  stage,
}: OrbProps): JSX.Element {
  const { copy, tasks } = list
  const [measureRef, listHeight] = useMeasuredHeight()
  const gesture = useRef<{ x: number; y: number; dragging: boolean } | null>(null)
  const suppressClick = useRef(false)
  const frame = useRef(0)
  const anchor = stage?.style === 'orb' ? stage : undefined
  const peeking = Boolean(peek) && !open
  const style = {
    '--pc': peek?.level === 'fault' ? 'var(--c-fault)' : 'var(--c-action)',
  } as CSSProperties
  const popStyle = { height: open ? Math.min(listHeight, POP_MAX_HEIGHT) : 0 } as CSSProperties

  const finishDrag = (): void => {
    if (!gesture.current?.dragging) return
    window.cancelAnimationFrame(frame.current)
    frame.current = 0
    void bridge?.drag('end')
    hit.hold.current = false
    window.requestAnimationFrame(hit.retest)
  }
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    suppressClick.current = false
    gesture.current = { x: event.clientX, y: event.clientY, dragging: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>): void => {
    const current = gesture.current
    if (!current || !bridge) return
    if (!current.dragging) {
      const moved = Math.hypot(event.clientX - current.x, event.clientY - current.y)
      if (moved <= DRAG_THRESHOLD) return
      current.dragging = true
      suppressClick.current = true
      hit.hold.current = true
      void bridge.drag('start')
    }
    if (frame.current) return
    frame.current = window.requestAnimationFrame(() => {
      frame.current = 0
      void bridge.drag('move')
    })
  }
  const onPointerEnd = (): void => {
    finishDrag()
    gesture.current = null
  }

  return (
    <div
      className="hud-c-orb"
      data-anchor-h={anchor?.anchorH ?? 'right'}
      data-anchor-v={anchor?.anchorV ?? 'top'}
      style={style}
    >
      <div
        className={`hud-c-say hud-c-surface${peeking ? ' is-on' : ''}`}
        data-hud-hit=""
        onClick={peeking ? onToggle : undefined}
      >
        {peek ? (
          <div className="hud-c-say-in">
            <PeekText copy={copy} locale={list.locale} others={tasks.length - 1} task={peek} />
          </div>
        ) : null}
      </div>
      <div
        className={`hud-c-pop hud-c-surface${open ? ' is-on' : ''}`}
        data-hud-hit=""
        style={popStyle}
      >
        <div className="hud-c-scroll">
          <div ref={measureRef} className="hud-c-measure">
            <TaskList list={list} />
          </div>
        </div>
      </div>
      <button
        aria-expanded={open}
        aria-label={`${copy.compact.orbLabel} (${fill(copy.compact.orbCount, tasks.length)})`}
        className={`hud-c-ball hud-c-surface${isUrgent(peek) && !open ? ' hud-c-urgent' : ''}`}
        data-hud-hit=""
        onClick={() => {
          if (suppressClick.current) suppressClick.current = false
          else onToggle()
        }}
        onPointerCancel={onPointerEnd}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        type="button"
      >
        <Ring tasks={tasks} />
        <span className="hud-c-count">{tasks.length}</span>
      </button>
    </div>
  )
}
