import { useEffect, useRef, type MutableRefObject } from 'react'

/** Main can reset the window to click-through on its own (hide, layout), so `true` is repeated. */
export const HUD_HIT_RESEND_MS = 250

export interface HudHitTest {
  /** While true the pointer is captured by a drag and the hit test must not flip the window. */
  hold: MutableRefObject<boolean>
  /** Re-tests the last known pointer position, for surfaces that move under a still cursor. */
  retest: () => void
}

/**
 * The compact stage window is transparent and click-through by default. Forwarded
 * mouse moves tell the renderer when the pointer is over a drawn surface
 * (`[data-hud-hit]`); only then the window turns interactive.
 */
export function useHudHitTest(
  setInteractive: ((interactive: boolean) => unknown) | undefined,
): HudHitTest {
  const hold = useRef(false)
  const retestRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!setInteractive) return
    let current: boolean | undefined
    let sentAt = 0
    let last: { x: number; y: number } | undefined
    const apply = (interactive: boolean): void => {
      const now = performance.now()
      if (interactive === current && (!interactive || now - sentAt < HUD_HIT_RESEND_MS)) return
      current = interactive
      sentAt = now
      void setInteractive(interactive)
    }
    const test = (): void => {
      if (hold.current || !last) return
      const element = document.elementFromPoint(last.x, last.y)
      apply(Boolean(element?.closest('[data-hud-hit]')))
    }
    const onMove = (event: MouseEvent): void => {
      last = { x: event.clientX, y: event.clientY }
      test()
    }
    const onLeave = (): void => {
      last = undefined
      if (!hold.current) apply(false)
    }
    // A hidden window can lose pointer events mid-gesture; never stay held or trust the cache.
    const onVisibility = (): void => {
      hold.current = false
      current = undefined
      last = undefined
    }
    retestRef.current = test
    // The main process may start interactive; settle on click-through first.
    apply(false)
    document.addEventListener('mousemove', onMove)
    document.documentElement.addEventListener('mouseleave', onLeave)
    document.addEventListener('transitionend', test, true)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.documentElement.removeEventListener('mouseleave', onLeave)
      document.removeEventListener('transitionend', test, true)
      document.removeEventListener('visibilitychange', onVisibility)
      retestRef.current = () => {}
    }
  }, [setInteractive])

  return { hold, retest: () => retestRef.current() }
}
