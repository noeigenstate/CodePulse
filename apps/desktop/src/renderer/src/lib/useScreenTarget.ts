import { useEffect, useState } from 'react'
import type { DeviceDisplaySnapshot } from '@codepulse/shared'

/** Coalesce source events into one read; rendering never starts another collector. */
export function useScreenTarget(active = true) {
  const [target, setTarget] = useState<DeviceDisplaySnapshot>()
  const [error, setError] = useState(false)
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
        const next = await window.codepulse.getDeviceDisplay()
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
  }, [active])
  return { target, error }
}
