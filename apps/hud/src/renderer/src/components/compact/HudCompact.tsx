import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { HudStageInfo } from '@codepulse/shared'
import type { ThemeMode } from '../../lib/dashboardSettings.js'
import type { AgentPanel } from '../../lib/displayAgents.js'
import {
  COMPACT_NOTICE_PEEK_MS,
  flattenTasks,
  peekKey,
  pickPeek,
  summarize,
  type CompactTask,
} from '../../lib/hudCompact.js'
import type { Locale, UiCopy } from '../../lib/i18n.js'
import { buildProjectDeckGroups, buildProjectUsageSummaries } from '../../lib/projectDeck.js'
import { useHudHitTest } from '../../lib/useHudHitTest.js'
import { useNow } from '../../lib/useNow.js'
import { EdgeSurface } from './EdgeSurface.js'
import { IslandSurface } from './IslandSurface.js'
import { OrbSurface } from './OrbSurface.js'
import { PillsSurface } from './PillsSurface.js'
import type { AckHandler, CompactStyle, HudCompactBridge, SurfaceProps } from './types.js'
import './hud-compact.css'

export interface HudCompactProps {
  allToolsHidden: boolean
  bridge?: HudCompactBridge
  copy: UiCopy
  locale: Locale
  onAck: AckHandler
  onDismiss: AckHandler
  panels: AgentPanel[]
  /** Read-only preview: no timers that hide things, no window events. */
  preview?: boolean
  /** False until the first status snapshot arrived; nothing peeks before that. */
  ready: boolean
  /** Preview only: draw the open list. */
  forceOpen?: boolean
  /** Preview only: show the peek line without waiting for or expiring its timer. */
  forcePeek?: boolean
  showUsageStrip: boolean
  style: CompactStyle
  theme: ThemeMode
}

const NO_KEYS: ReadonlySet<string> = new Set()

/**
 * Fault and action alerts stay peeked while they last. A notice peeks once for a
 * few seconds, then only its unread mark remains. Notices already present when
 * the first snapshot arrives count as seen, so a restart does not replay them.
 */
function usePeek(
  tasks: CompactTask[],
  fixed: boolean,
  ready: boolean,
): { peek: CompactTask | undefined; settle: () => void } {
  const spent = useRef<Set<string>>()
  if (ready && !spent.current) {
    spent.current = new Set(tasks.filter((task) => task.level === 'notice').map(peekKey))
  }
  const [, redraw] = useReducer((count: number) => count + 1, 0)
  const peek = ready && spent.current ? pickPeek(tasks, fixed ? NO_KEYS : spent.current) : undefined
  const timed = !fixed && peek?.level === 'notice' ? peekKey(peek) : undefined

  useEffect(() => {
    if (!timed) return
    const timer = window.setTimeout(() => {
      spent.current?.add(timed)
      redraw()
    }, COMPACT_NOTICE_PEEK_MS)
    return () => window.clearTimeout(timer)
  }, [timed])

  const settle = useCallback(() => {
    for (const task of tasks) if (task.level === 'notice') spent.current?.add(peekKey(task))
  }, [tasks])
  return { peek, settle }
}

function useStage(bridge: HudCompactBridge | undefined): HudStageInfo | undefined {
  const [stage, setStage] = useState<HudStageInfo>()
  useEffect(() => {
    if (!bridge) return
    let alive = true
    void bridge.getStage().then((next) => {
      if (alive) setStage((current) => current ?? next)
    })
    const stop = bridge.onStage((next) => setStage(next))
    return () => {
      alive = false
      stop()
    }
  }, [bridge])
  return stage
}

/** Island, pills, edge drawer or orb. They share one task model, peek rules and open list. */
export function HudCompact({
  allToolsHidden,
  bridge,
  copy,
  forceOpen = false,
  forcePeek = false,
  locale,
  onAck,
  onDismiss,
  panels,
  preview = false,
  ready,
  showUsageStrip,
  style,
  theme,
}: HudCompactProps): JSX.Element {
  const now = useNow(30_000)
  const groups = useMemo(() => buildProjectDeckGroups(panels), [panels])
  const tasks = useMemo(() => flattenTasks(groups, copy.unknownProject), [groups, copy])
  const usage = useMemo(() => buildProjectUsageSummaries(panels), [panels])
  const summary = useMemo(() => summarize(tasks), [tasks])
  const { peek, settle } = usePeek(tasks, forcePeek, ready)
  const [userOpen, setUserOpen] = useState(false)
  const [collapseTick, collapse] = useReducer((count: number) => count + 1, 0)
  const hit = useHudHitTest(preview ? undefined : bridge?.setInteractive)
  const stage = useStage(preview ? undefined : bridge)
  const open = forceOpen || userOpen

  useEffect(() => {
    if (preview) return
    const close = (): void => {
      setUserOpen(false)
      collapse()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [preview])

  const onToggle = useCallback(() => {
    if (forceOpen) return
    if (!userOpen) settle()
    setUserOpen(!userOpen)
  }, [forceOpen, settle, userOpen])

  const surface: SurfaceProps = {
    list: { allToolsHidden, copy, locale, now, onAck, onDismiss, showUsageStrip, tasks, usage },
    onToggle,
    open,
    peek: open ? undefined : peek,
    summary,
  }

  return (
    <div className="hud-c" data-c-style={style} data-c-theme={theme}>
      {style === 'island' ? <IslandSurface {...surface} /> : null}
      {style === 'pills' ? <PillsSurface {...surface} collapseTick={collapseTick} /> : null}
      {style === 'edge' ? <EdgeSurface {...surface} /> : null}
      {style === 'orb' ? <OrbSurface {...surface} bridge={bridge} hit={hit} stage={stage} /> : null}
    </div>
  )
}
