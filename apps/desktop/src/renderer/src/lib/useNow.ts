import { useEffect, useState } from 'react'
import { UI_REFRESH_INTERVAL_MS } from './timing.js'

export function useNow(intervalMs = UI_REFRESH_INTERVAL_MS): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let timer: number | undefined

    const stop = (): void => {
      if (timer !== undefined) window.clearInterval(timer)
      timer = undefined
    }
    const start = (): void => {
      stop()
      if (!document.hidden) timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    }
    const handleVisibility = (): void => {
      setNow(Date.now())
      start()
    }

    start()
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [intervalMs])

  return now
}
