/**
 * Xiaomi MiMo console login for Token Plan quota.
 *
 * The quota API only accepts the platform console's SSO cookie, so CodePulse
 * hosts the official Xiaomi login page in an isolated persistent partition and
 * reads the resulting cookies from it. Nothing is written to CodePulse's own
 * files; logging out clears the partition.
 *
 * @module main/mimo-auth
 */
import { BrowserWindow, session, shell, type Session } from 'electron'

const PARTITION = 'persist:mimo-console'
const PLATFORM_ORIGIN = 'https://platform.xiaomimimo.com'
/** Returns a JSON 401 with the SSO `loginUrl` when the session is logged out. */
const LOGIN_PROBE_URL = `${PLATFORM_ORIGIN}/api/v1/tokenPlan/detail`
/** Silent renewal loads the SSO page headlessly; bound how often and how long. */
const SILENT_REFRESH_MIN_INTERVAL_MS = 10 * 60_000
const SILENT_REFRESH_TIMEOUT_MS = 20_000
/** Hosts the login window may navigate or open popups to (Xiaomi SSO + console). */
const TRUSTED_HOST_SUFFIXES = ['xiaomimimo.com', 'xiaomi.com', 'mi.com']

let loginWindow: BrowserWindow | null = null
let lastSilentRefreshAt = 0
let silentRefresh: Promise<string | undefined> | null = null

/** Returns the isolated session holding the MiMo console login. */
function mimoSession(): Session {
  return session.fromPartition(PARTITION)
}

/**
 * Checks whether a URL belongs to the Xiaomi login or MiMo console.
 * @param raw URL to inspect.
 * @returns Whether it is an https URL on a trusted host.
 */
function isTrustedUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return (
      url.protocol === 'https:' &&
      TRUSTED_HOST_SUFFIXES.some(
        (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
      )
    )
  } catch {
    return false
  }
}

/**
 * Builds the console cookie header when the partition holds a complete login.
 *
 * @returns `name=value; …` header, or `undefined` without `serviceToken` + `userId`.
 */
export async function readMimoCookie(): Promise<string | undefined> {
  const cookies = await mimoSession().cookies.get({ url: PLATFORM_ORIGIN })
  const has = (pattern: RegExp): boolean =>
    cookies.some((cookie) => pattern.test(cookie.name) && cookie.value.trim() !== '')
  if (!has(/^(?:api-platform_)?serviceToken$/) || !has(/^userId$/)) return undefined
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
}

/**
 * Cookie provider for the local server: reads the login and, when asked,
 * renews an expired `serviceToken` through the Xiaomi SSO `passToken`.
 *
 * @param request Whether to renew, plus the SSO URL from the console's 401.
 * @returns Current cookie header, or `undefined` when logged out.
 */
export async function provideMimoCookie(request: {
  refresh: boolean
  loginUrl?: string
}): Promise<string | undefined> {
  if (!request.refresh) return readMimoCookie()
  if (silentRefresh) return silentRefresh
  if (Date.now() - lastSilentRefreshAt < SILENT_REFRESH_MIN_INTERVAL_MS) return readMimoCookie()
  lastSilentRefreshAt = Date.now()
  silentRefresh = renewSilently(request.loginUrl).finally(() => {
    silentRefresh = null
  })
  return silentRefresh
}

/**
 * Loads the SSO login URL in a hidden window; a live `passToken` redirects
 * straight back to the console and re-issues `serviceToken`.
 *
 * @param loginUrl SSO URL from the 401 envelope, when known.
 * @returns Renewed cookie header, or `undefined` when a manual login is needed.
 */
async function renewSilently(loginUrl: string | undefined): Promise<string | undefined> {
  const target = loginUrl && isTrustedUrl(loginUrl) ? loginUrl : await resolveLoginUrl()
  const before = await readMimoCookie()
  const win = new BrowserWindow({
    show: false,
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true },
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SILENT_REFRESH_TIMEOUT_MS)
      const onCookie = (): void => {
        void readMimoCookie().then((cookie) => {
          if (cookie && cookie !== before) {
            clearTimeout(timer)
            resolve()
          }
        })
      }
      mimoSession().cookies.on('changed', onCookie)
      win.on('closed', () => mimoSession().cookies.off('changed', onCookie))
      void win.loadURL(target).catch(() => undefined)
    })
    return await readMimoCookie()
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/**
 * Asks the console for its SSO login URL (it embeds a signed callback).
 * @returns SSO URL, or the console root when the probe fails.
 */
async function resolveLoginUrl(): Promise<string> {
  try {
    const response = await mimoSession().fetch(LOGIN_PROBE_URL, {
      headers: { Accept: 'application/json' },
    })
    const body = (await response.json()) as { loginUrl?: unknown }
    if (typeof body.loginUrl === 'string' && isTrustedUrl(body.loginUrl)) return body.loginUrl
  } catch {
    // Fall back to the console, which offers its own login entry.
  }
  return `${PLATFORM_ORIGIN}/`
}

/**
 * Opens the Xiaomi login window and resolves once the console cookie appears
 * or the user closes the window.
 *
 * @param parent Window to attach the login dialog to.
 * @returns Whether a usable login is present afterwards.
 */
export async function openMimoLogin(parent: BrowserWindow | null): Promise<boolean> {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus()
    return new Promise((resolve) => {
      loginWindow?.once('closed', () => void readMimoCookie().then((c) => resolve(Boolean(c))))
    })
  }
  const target = await resolveLoginUrl()
  const before = await readMimoCookie()
  const win = new BrowserWindow({
    width: 480,
    height: 720,
    parent: parent ?? undefined,
    title: 'Xiaomi MiMo',
    autoHideMenuBar: true,
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true },
  })
  loginWindow = win
  // Keep SSO popups (QR login, third-party auth) inside the isolated session; send the rest to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedUrl(url)) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isTrustedUrl(url)) return
    event.preventDefault()
    void shell.openExternal(url)
  })

  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      mimoSession().cookies.off('changed', onCookie)
      resolve(ok)
      if (!win.isDestroyed()) win.close()
    }
    const onCookie = (): void => {
      void readMimoCookie().then((cookie) => {
        if (cookie && cookie !== before) finish(true)
      })
    }
    mimoSession().cookies.on('changed', onCookie)
    win.on('closed', () => {
      loginWindow = null
      void readMimoCookie().then((cookie) => finish(Boolean(cookie)))
    })
    void win.loadURL(target).catch(() => undefined)
  })
}

/** Clears the MiMo login from the isolated partition. */
export async function logoutMimo(): Promise<void> {
  await mimoSession().clearStorageData()
  lastSilentRefreshAt = 0
}
