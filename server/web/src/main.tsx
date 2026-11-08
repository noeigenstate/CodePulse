import '@fontsource-variable/inter'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { api, useMockApi } from './api'
import { App } from './App'
import { storeSession } from './session'
import './styles.css'

const params = new URLSearchParams(location.search)

/** `?theme=` wins; otherwise follow the system, which the embedding desktop also follows. */
function applyTheme() {
  const dark = matchMedia('(prefers-color-scheme: dark)')
  const apply = () => {
    const theme = params.get('theme') ?? (dark.matches ? 'dark' : 'light')
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light'
  }
  apply()
  dark.addEventListener('change', apply)
}

/** The desktop opens the store with a one-time code that is traded for a session token. */
async function startSession() {
  const code = params.get('code')
  if (!code) return
  params.delete('code')
  const query = params.toString()
  history.replaceState(null, '', `${location.pathname}${query && `?${query}`}${location.hash}`)
  // A spent or expired code only means the page stays in browse-only mode.
  await api.storeSession(code).then(
    ({ token }) => storeSession.set(token),
    () => undefined,
  )
}

async function main() {
  applyTheme()
  // The fake API is only reachable from dev builds, so production bundles drop it.
  if (import.meta.env.DEV && params.has('mock')) useMockApi((await import('./mock')).mockApi)
  await startSession()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void main()
