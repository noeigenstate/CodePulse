import type { IpcMain } from 'electron'
import type { ProductShell } from './product-shell.js'
import type { ScreenWorkbenchWindow } from './screen-workbench-window.js'
export function registerProductIpc(
  ipc: Pick<IpcMain, 'handle'>,
  shell: ProductShell,
  screen: Pick<ScreenWorkbenchWindow, 'configure'>,
): void {
  ipc.handle('codepulse:shell-get', () => shell.snapshot())
  ipc.handle('codepulse:shell-navigate', (_event, view: unknown) => shell.navigate(view))
  ipc.handle('codepulse:shell-form', (_event, form: unknown) => shell.selectForm(form))
  ipc.handle('codepulse:shell-open', (_event, surface: unknown, view: unknown) =>
    shell.open(surface, view),
  )
  ipc.handle('codepulse:workbench-configure', (event, patch: unknown) =>
    screen.configure(event.sender.id, patch),
  )
}
