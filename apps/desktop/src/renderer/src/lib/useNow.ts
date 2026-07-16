import { useEffect, useState } from 'react'
import { UI_REFRESH_INTERVAL_MS } from './timing.js'

/**
 * Shared clock: one setInterval per intervalMs, many React subscribers.
 * Avoids N independent 500ms timers when many meters/tiles call useNow().
 */
const subscribers = new Map<number, Set<(now: number) => void>>()
const timers = new Map<number, number>()

function ensureClock(intervalMs: number): void {
  if (timers.has(intervalMs)) return
  const id = window.setInterval(() => {
    if (document.hidden) return
    const now = Date.now()
    const set = subscribers.get(intervalMs)
    if (!set) return
    for (const cb of set) cb(now)
  }, intervalMs)
  timers.set(intervalMs, id)
}

function subscribeClock(intervalMs: number, cb: (now: number) => void): () => void {
  let set = subscribers.get(intervalMs)
  if (!set) {
    set = new Set()
    subscribers.set(intervalMs, set)
  }
  set.add(cb)
  ensureClock(intervalMs)
  return () => {
    set!.delete(cb)
    if (set!.size === 0) {
      subscribers.delete(intervalMs)
      const id = timers.get(intervalMs)
      if (id !== undefined) {
        window.clearInterval(id)
        timers.delete(intervalMs)
      }
    }
  }
}

export function useNow(intervalMs = UI_REFRESH_INTERVAL_MS): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const onTick = (value: number): void => setNow(value)
    const handleVisibility = (): void => {
      setNow(Date.now())
    }
    const unsub = subscribeClock(intervalMs, onTick)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      unsub()
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [intervalMs])

  return now
}
