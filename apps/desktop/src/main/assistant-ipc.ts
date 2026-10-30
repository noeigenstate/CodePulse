import type { IpcMain } from 'electron'
import type { DeskTaskInput } from '@codepulse/shared'
import type { createAssistantRuntime } from './assistant-runtime.js'
import { publicAssistantError } from './assistant-service.js'
import type { DeviceStatusV1 } from '@codepulse/shared'
import { withAmbient } from './ambient-rules.js'

export function registerAssistantIpc(
  ipc: Pick<IpcMain, 'handle'>,
  runtime: () => ReturnType<typeof createAssistantRuntime> | undefined,
  deviceSnapshot?: () => DeviceStatusV1,
  onManualShow?: () => void,
): void {
  const handle = (
    name: string,
    action: (r: ReturnType<typeof createAssistantRuntime>, ...args: unknown[]) => unknown,
  ) => {
    ipc.handle('codepulse:assistant-' + name, async (_event, ...args: unknown[]) => {
      try {
        const r = runtime()
        if (!r) throw new Error('待办服务暂不可用，请检查本地存储或重启客户端')
        return await action(r, ...args)
      } catch (error) {
        throw new Error(publicAssistantError(error))
      }
    })
  }
  const task = (value: unknown): DeskTaskInput => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('待办格式无效')
    return value as DeskTaskInput
  }
  handle('get', (r) => r.service.snapshot())
  handle('preview', (r) => {
    if (!deviceSnapshot) throw new Error('预览暂不可用')
    const base = deviceSnapshot()
    return withAmbient(
      {
        ...base,
        mainState: 'idle',
        threads: [],
        threadTotal: 0,
        agents: base.agents.map((a) => ({ ...a, state: 'idle', needsAttention: false })),
      },
      r.service.inkCard({ agents: [] }, true),
    )
  })
  handle('configure', (r, value) => r.service.configure(value))
  handle('key', (r, field, value) => r.setKey(field, value))
  handle('add', (r, value) => r.service.add(task(value)))
  handle('update', (r, id, value) => r.service.update(id as string, task(value)))
  handle('complete', (r, id) => r.service.finish(id as string))
  handle('cancel', (r, id) => r.service.finish(id as string, true))
  handle('snooze', (r, id, seconds) => r.service.snooze(id as string, seconds as number))
  handle('forget', (r, id) => r.service.forget(id as string))
  handle('interpret', (r, value) => r.service.interpret(value))
  handle('apply', (r, id) => r.service.apply(id as string))
  handle('listen', (r, pcm) => r.service.listen(pcm as Uint8Array))
  handle('speak', (r, value) => r.service.speak(value))
  handle('show-ink', (r) => {
    const result = r.service.showOnInk()
    onManualShow?.()
    return result
  })
  handle('hide-ink', (r) => r.service.hideOnInk())
}
