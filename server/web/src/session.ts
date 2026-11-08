/** A bearer token kept in a browser storage; storage may be blocked, so every access is guarded. */
export interface TokenSlot {
  get(): string
  set(token: string): void
  clear(): void
  subscribe(listener: () => void): () => void
}

function tokenSlot(storage: () => Storage, key: string): TokenSlot {
  const listeners = new Set<() => void>()
  const write = (token: string) => {
    try {
      if (token) storage().setItem(key, token)
      else storage().removeItem(key)
    } catch {
      // Storage unavailable: the token only lives until the page closes.
    }
    listeners.forEach((listener) => listener())
  }
  return {
    get() {
      try {
        return storage().getItem(key) ?? ''
      } catch {
        return ''
      }
    },
    set: write,
    clear: () => write(''),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Store session: bound to one desktop client, gone when the embedding tab closes. */
export const storeSession = tokenSlot(() => sessionStorage, 'codepulse.store')
/** Developer session: kept across visits. */
export const devSession = tokenSlot(() => localStorage, 'codepulse.dev')
