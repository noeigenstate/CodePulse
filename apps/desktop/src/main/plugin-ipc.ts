import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import type { PluginOpenResult } from './plugin-platform.js'

export function registerPluginIpc(
  ipc: Pick<IpcMain, 'handle'>,
  deps: {
    trusted: (event: IpcMainInvokeEvent) => boolean
    theme: () => 'light' | 'dark'
    open: (theme: 'light' | 'dark') => Promise<PluginOpenResult>
    refresh: () => Promise<void>
  },
): void {
  ipc.handle('plugins:open', (event) =>
    deps.trusted(event) ? deps.open(deps.theme()) : { error: '无权限' },
  )
  ipc.handle('plugins:changed', async (event) => {
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
  contents.on('did-fail-load', (_event, code, _description, url, mainFrame) => {
    if (!mainFrame && code !== -3 && url && new URL(url).origin === platformOrigin)
      contents.send('plugins:load-error')
  })
}
