import { useEffect, useState } from 'react'
import type { InkScreenStatus } from '@codepulse/shared'

/**
 * The one reader of "what is on the e-ink screen" for every page. The main process owns the
 * computation and broadcasts changes; this hook only follows it, plus a slow heartbeat so
 * countdowns and the connection window stay current while nothing else changes.
 */
export function useInkStatus(): InkScreenStatus | undefined {
  const [status, setStatus] = useState<InkScreenStatus>()
  useEffect(() => {
    let alive = true
    let received = false
    const read = () =>
      void window.codepulse
        .getInkStatus()
        .then((next) => { if (alive) setStatus(next) })
        .catch(() => {})
    const stop = window.codepulse.onInkStatus((next) => { received = true; if (alive) setStatus(next) })
    if (!received) read()
    const heartbeat = setInterval(read, 30000)
    return () => { alive = false; stop(); clearInterval(heartbeat) }
  }, [])
  return status
}

/** Minutes left, rounded up, for a countdown label; 0 when already past. */
export function minutesUntil(at: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((at - now) / 60000))
}
