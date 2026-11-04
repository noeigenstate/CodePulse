import { useEffect, useState } from 'react'
import type {
  DeviceDisplayConfig,
  InkPerformanceOptions,
  PerformancePreview,
} from '@codepulse/shared'

/** Only this visible preview requests samples. Physical readers independently renew demand. */
export function usePerformancePreview(
  active: boolean,
  options: InkPerformanceOptions,
  display: DeviceDisplayConfig,
) {
  const [result, setResult] = useState<PerformancePreview>()
  const [error, setError] = useState(false)
  const signature = JSON.stringify([options, display])
  useEffect(() => {
    if (!active) return
    let generation = 0,
      timer: ReturnType<typeof setTimeout> | undefined
    async function read(ticket: number) {
      if (ticket !== generation || document.visibilityState !== 'visible') return
      let delay = 30_000
      try {
        const next = await window.codepulse.getPerformancePreview(options, display)
        if (ticket !== generation) return
        setResult(next)
        setError(!next.status)
        if (next.warming) delay = 1500
      } catch {
        if (ticket === generation) setError(true)
      }
      if (ticket === generation) timer = setTimeout(() => void read(ticket), delay)
    }
    function sync() {
      clearTimeout(timer)
      const ticket = ++generation
      if (document.visibilityState === 'visible') void read(ticket)
    }
    setResult(undefined)
    setError(false)
    document.addEventListener('visibilitychange', sync)
    sync()
    return () => {
      ++generation
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [active, signature])
  return { result, error }
}
