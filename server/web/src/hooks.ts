import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { TokenSlot } from './session'

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Loads on mount and whenever `deps` change; keeps the previous data while reloading. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error: string }>({ error: '' })
  const latest = useRef(0)
  const reload = useCallback(() => {
    const id = ++latest.current
    // A slower, older request must not overwrite the result of a newer one.
    const settle = (next: { data?: T; error: string }) => id === latest.current && setState(next)
    return load().then(
      (data) => settle({ data, error: '' }),
      (e) => settle({ error: errorText(e) }),
    )
  }, deps)
  useEffect(() => void reload(), [reload])
  return { ...state, reload }
}

/** Busy flag and error text for one async button. */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

export const useToken = (slot: TokenSlot) => useSyncExternalStore(slot.subscribe, slot.get)

const hashListeners = (listener: () => void) => {
  window.addEventListener('hashchange', listener)
  return () => window.removeEventListener('hashchange', listener)
}

export type Route =
  | { page: 'discover' | 'installed' | 'developer' | 'review' }
  | { page: 'plugin'; id: string }

/** The tab and plugin live in the hash so the back button works. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(hashListeners, () => location.hash)
  const [, page = '', id = ''] = hash.split('/')
  if (page === 'plugin' && id) return { page, id: decodeURIComponent(id) }
  return {
    page: page === 'installed' || page === 'developer' || page === 'review' ? page : 'discover',
  }
}
