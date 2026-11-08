import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import type {
  CloudPluginsResult,
  PluginMutationResult,
  PluginOpenOptions,
  PluginOpenResult,
} from './plugin-platform.js'
import type { PluginLogoStore } from './plugin-logos.js'

export function coalescePluginChanges(changed: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  return () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      try {
        changed()
      } catch {
        // A window may close before a queued notification is sent.
      }
    }, 300)
    timer.unref?.()
  }
}

export function registerPluginIpc(
  ipc: Pick<IpcMain, 'handle'>,
  deps: {
    trusted: (event: IpcMainInvokeEvent) => boolean
    theme: () => 'light' | 'dark'
    open: (theme: 'light' | 'dark', options?: PluginOpenOptions) => Promise<PluginOpenResult>
    refresh: () => Promise<void>
    list: () => Promise<CloudPluginsResult>
    setEnabled: (id: string, enabled: boolean) => Promise<PluginMutationResult>
    uninstall: (id: string) => Promise<PluginMutationResult>
    logos: Pick<PluginLogoStore, 'list' | 'pick' | 'reset'>
  },
): void {
  // The renderer's resolved theme wins: main's window theme follows its own schedule.
  ipc.handle('plugins:open', (event, options?: PluginOpenOptions) => {
    if (!deps.trusted(event)) return { error: '无权限' }
    const theme =
      options?.theme === 'light' || options?.theme === 'dark' ? options.theme : deps.theme()
    return deps.open(theme, options)
  })
  ipc.handle('plugins:list', (event): Promise<CloudPluginsResult> | CloudPluginsResult =>
    deps.trusted(event) ? deps.list() : { state: 'offline', platformOrigin: '', plugins: [] },
  )
  ipc.handle('plugins:set-enabled', (event, id: string, enabled: boolean) =>
    deps.trusted(event) ? deps.setEnabled(id, enabled) : { error: '无权限' },
  )
  ipc.handle('plugins:uninstall', (event, id: string) =>
    deps.trusted(event) ? deps.uninstall(id) : { error: '无权限' },
  )
  ipc.handle('plugins:logos', (event) => (deps.trusted(event) ? deps.logos.list() : {}))
  ipc.handle('plugins:pick-logo', (event, id: string) =>
    deps.trusted(event) ? deps.logos.pick(id) : { error: '无权限' },
  )
  ipc.handle('plugins:reset-logo', (event, id: string) => {
    if (!deps.trusted(event)) return { error: '无权限' }
    try {
      return deps.logos.reset(id)
    } catch {
      return { error: '图标未能重置' }
    }
  })
  ipc.handle('plugins:refresh', async (event) => {
    if (deps.trusted(event)) await deps.refresh()
  })
}

export function guardPluginNavigation(
  contents: WebContents,
  platformUrl: string | undefined,
  openExternal: (url: string) => Promise<unknown>,
): void {
  const platformOrigin = platformUrl ? new URL(platformUrl).origin : undefined
  const external = (url: string) => {
    if (/^https?:\/\//i.test(url)) void openExternal(url).catch(() => {})
  }
  contents.setWindowOpenHandler(({ url }) => {
    external(url)
    return { action: 'deny' }
  })
  const navigate = (event: { url: string; isMainFrame: boolean; preventDefault: () => void }) => {
    if (event.isMainFrame) return
    if (new URL(event.url).origin === platformOrigin) return
    event.preventDefault()
    external(event.url)
  }
  contents.on('will-frame-navigate', navigate)
  contents.on('will-redirect', navigate)
  // Same-origin hash changes inside the store let the renderer reload it on a theme switch
  // without losing the page the user is on.
  contents.on('did-navigate-in-page', (_event, url, mainFrame) => {
    if (!mainFrame && platformOrigin && new URL(url).origin === platformOrigin)
      contents.send('plugins:location', url)
  })
  contents.on('did-fail-load', (_event, code, _description, url, mainFrame) => {
    if (!mainFrame && code !== -3 && url && new URL(url).origin === platformOrigin)
      contents.send('plugins:load-error')
  })
}
