import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from 'react'
import {
  ORB_POPUP_MAX_HEIGHT,
  isUrgent,
  orbPopupMaxHeight,
  topTask,
  type CompactTask,
} from '../../lib/hudCompact.js'
import { turnStateLabel } from '../../lib/i18n.js'
import { StateMark } from './StateMark.js'
import { PeekText, TaskList, fill, useLastDefined, useMeasuredHeight } from './TaskRow.js'
import type { OrbProps } from './types.js'

const DRAG_THRESHOLD = 4
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
  const { copy, locale, tasks } = list
  const [measureRef, listHeight] = useMeasuredHeight()
  const gesture = useRef<{ x: number; y: number; dragging: boolean } | null>(null)
  const suppressClick = useRef(false)
  const frame = useRef(0)
  const live = useRef({ bridge, hit })
  live.current = { bridge, hit }
  const [popMax, setPopMax] = useState(ORB_POPUP_MAX_HEIGHT)
  const anchor = stage?.style === 'orb' ? stage : undefined
  const peeking = Boolean(peek) && !open
  const shownPeek = useLastDefined(peek)
  const top = topTask(tasks)
  const style = {
    '--pc': peek?.level === 'fault' ? 'var(--c-fault)' : 'var(--c-action)',
    '--c-pop-max': `${popMax}px`,
  } as CSSProperties
  const popStyle = { height: open ? Math.min(listHeight, popMax) : 0 } as CSSProperties

  // Short displays: size the popup to the room left on the display when it opens.
  useLayoutEffect(() => {
    if (!open || !bridge) return
    setPopMax(
      orbPopupMaxHeight({
        anchorV: anchor?.anchorV ?? 'top',
        windowY: window.screenY,
        stageHeight: window.innerHeight,
        availTop: (window.screen as Screen & { availTop?: number }).availTop ?? 0,
        availHeight: window.screen.availHeight,
      }),
    )
  }, [open, bridge, anchor?.anchorV])

  /** Ends an open drag exactly once and releases the hit test, whatever interrupted it. */
  const finishDrag = (): void => {
    const current = gesture.current
    gesture.current = null
    if (!current?.dragging) return
    window.cancelAnimationFrame(frame.current)
    frame.current = 0
    void live.current.bridge?.drag('end')
    live.current.hit.hold.current = false
    window.requestAnimationFrame(live.current.hit.retest)
  }
  useEffect(() => {
    const onHidden = (): void => {
      if (document.hidden) finishDrag()
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      finishDrag()
    }
    // finishDrag only reads refs.
  }, [])

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    finishDrag()
    suppressClick.current = false
    gesture.current = { x: event.clientX, y: event.clientY, dragging: false }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // The pointer is already gone; the gesture below simply ends on the next move.
    }
  }
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>): void => {
    const current = gesture.current
    if (!current || !bridge) return
    // The button was released somewhere we never heard about (window hidden, focus lost).
    if (event.buttons === 0) {
      finishDrag()
      return
    }
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
        {shownPeek ? (
          <div className="hud-c-say-in">
            <PeekText copy={copy} locale={locale} others={tasks.length - 1} task={shownPeek} />
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
        aria-label={`${copy.compact.orbLabel} (${fill(copy.compact.orbCount, tasks.length)}${
          top ? `, ${turnStateLabel(top.card.agent.state, locale)}` : ''
        })`}
        className={`hud-c-ball hud-c-surface${isUrgent(peek) && !open ? ' hud-c-urgent' : ''}`}
        data-hud-hit=""
        onClick={() => {
          if (suppressClick.current) suppressClick.current = false
          else onToggle()
        }}
        onLostPointerCapture={finishDrag}
        onPointerCancel={finishDrag}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        type="button"
      >
        <Ring tasks={tasks} />
        <span className="hud-c-count">{tasks.length}</span>
        {top ? (
          <span className="hud-c-badge">
            <StateMark level={top.level} />
          </span>
        ) : null}
      </button>
    </div>
  )
}
