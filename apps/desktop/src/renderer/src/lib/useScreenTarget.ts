import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeviceDisplaySnapshot } from '@codepulse/shared'

/** Coalesce source events into one read; rendering never starts another collector. */
export function useScreenTarget(active = true, viewing = false) {
  const [target, setTarget] = useState<DeviceDisplaySnapshot>()
  const [error, setError] = useState(false)
  const reader = useRef<() => Promise<void>>()
  useEffect(() => {
    if (!active) return
    let alive = true,
      busy = false,
      again = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      if (busy) {
        again = true
        return
      }
      busy = true
      try {
        const next = await window.codepulse.getDeviceDisplay(
          undefined,
          viewing && document.visibilityState === 'visible',
        )
        if (alive) {
          setTarget(next)
          setError(false)
        }
      } catch {
        if (alive) setError(true)
      } finally {
        busy = false
        if (alive && again) {
          again = false
          schedule()
        }
      }
    }
    reader.current = read
    const schedule = () => {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined
          void read()
        }, 160)
    }
    const stops = [
      window.codepulse.onStatus(schedule),
      window.codepulse.onAmbient(schedule),
      window.codepulse.onAssistant(schedule),
      window.codepulse.onDeviceDisplay(schedule),
    ]
    void read()
    const heartbeat = setInterval(schedule, 30000)
    return () => {
      alive = false
      stops.forEach((stop) => stop())
      clearInterval(heartbeat)
      clearTimeout(timer)
    }
  }, [active, viewing])
  const retry = useCallback(() => void reader.current?.(), [])
  return { target, error, retry }
}
