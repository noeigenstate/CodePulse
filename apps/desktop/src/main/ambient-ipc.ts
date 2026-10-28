import type { IpcMain } from 'electron'
import type { AmbientConfig, DeviceStatusV1 } from '@codepulse/shared'
import type { createAmbientRuntime } from './ambient-runtime.js'
import { withAmbient } from './ambient-rules.js'

/** Same handlers for the unified host and isolated renderer integration tests. */
export function registerAmbientIpc(
  ipc: Pick<IpcMain, 'handle'>,
  runtime: ReturnType<typeof createAmbientRuntime>,
  deviceSnapshot: () => DeviceStatusV1,
  openExternal: (url: string) => Promise<unknown>,
): void {
  ipc.handle('codepulse:ambient-import', (_event, bytes: unknown, name: unknown) =>
    runtime.importImage(bytes, name),
  )
  ipc.handle('codepulse:ambient-note', (_event, text: unknown) =>
    runtime.service.addPersonal('note', text),
  )
  ipc.handle('codepulse:ambient-remove', (_event, id: unknown) =>
    runtime.service.removePersonal(id),
  )
  ipc.handle('codepulse:ambient-get', () => runtime.service.snapshot())
  ipc.handle('codepulse:ambient-set', (_event, config: unknown) =>
    runtime.service.configure(config),
  )
  ipc.handle('codepulse:ambient-key', (_event, provider: AmbientConfig['provider'], key: unknown) =>
    runtime.setKey(provider, key),
  )
  ipc.handle('codepulse:ambient-refresh', () => runtime.service.refresh(true))
  ipc.handle('codepulse:ambient-show', (_event, id: string) => runtime.service.showManual(id))
  ipc.handle('codepulse:ambient-dismiss', () => runtime.service.dismiss())
  ipc.handle('codepulse:ambient-preview', (_event, id: string) => {
    const card = runtime.service.snapshot().cards.find((c) => c.id === id)
    if (!card) throw new Error('Content expired')
    const base = deviceSnapshot()
    // An explicit local layout preview never acknowledges or rewrites live work.
    return withAmbient(
      {
        ...base,
        mainState: 'idle',
        threads: [],
        threadTotal: 0,
        display: base.display ? { ...base.display, page: 0 } : undefined,
        agents: base.agents.map((a) => ({ ...a, state: 'idle', needsAttention: false })),
      },
      card,
    )
  })
  ipc.handle('codepulse:ambient-open', async (_event, id: string) => {
    const card = runtime.service.snapshot().cards.find((c) => c.id === id)
    if (
      !card ||
      !/^https:\/\/(?:x\.com|redd\.it|(?:www\.)?reddit\.com|news\.ycombinator\.com|openstax\.org|plato\.stanford\.edu)\//.test(
        card.url,
      )
    )
      throw new Error('Content unavailable')
    await openExternal(card.url)
  })
}
