import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage, net } from 'electron'
import type { AssistantSecret } from '@codepulse/shared'
import { AssistantStore } from './assistant-store.js'
import { LumaAssistantProvider, type AssistantKeys } from './assistant-provider.js'
import {
  AssistantService,
  normalizeAssistantSettings,
  type AssistantDependencies,
} from './assistant-service.js'

export function createAssistantRuntime(
  directory: string,
  deps: Pick<AssistantDependencies, 'changed' | 'notify' | 'automaticAllowed' | 'restoreWork'>,
) {
  mkdirSync(directory, { recursive: true })
  const settingsPath = join(directory, 'assistant-settings.json'),
    keysPath = join(directory, 'assistant-keys.json')
  const read = (path: string): Record<string, unknown> => {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'))
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch {
      return {}
    }
  }
  const write = (path: string, value: unknown) => {
    writeFileSync(path + '.tmp', JSON.stringify(value), { mode: 0o600 })
    renameSync(path + '.tmp', path)
  }
  const keys: AssistantKeys = {
    llmKey: '',
    llmKeys: {
      glm: process.env.CODEPULSE_GLM_API_KEY ?? '',
      tongyi: process.env.CODEPULSE_TONGYI_API_KEY ?? '',
    },
    speechAppKey: process.env.CODEPULSE_ALIYUN_NLS_APPKEY ?? '',
    speechToken: process.env.CODEPULSE_ALIYUN_NLS_TOKEN ?? '',
  }
  const encrypted = read(keysPath)
  const secureAvailable = () =>
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend?.() !== 'basic_text')
  if (secureAvailable())
    for (const field of ['speechAppKey', 'speechToken'] as const) {
      try {
        if (typeof encrypted[field] === 'string')
          keys[field] = safeStorage.decryptString(Buffer.from(encrypted[field] as string, 'base64'))
      } catch {
        /* locked store: keep explicit process credentials only */
      }
    }
  const store = new AssistantStore(join(directory, 'assistant.sqlite'))
  let service: AssistantService
  try {
    const initial = normalizeAssistantSettings(store.settings() ?? read(settingsPath))
    const generic = process.env.CODEPULSE_ASSISTANT_API_KEY ?? ''
    if (generic && !keys.llmKeys![initial.provider]) keys.llmKeys![initial.provider] = generic
    if (secureAvailable())
      for (const provider of ['glm', 'tongyi'] as const) {
        try {
          const value =
            encrypted['llm:' + provider] ??
            (provider === initial.provider ? encrypted.llmKey : undefined)
          if (typeof value === 'string')
            keys.llmKeys![provider] = safeStorage.decryptString(Buffer.from(value, 'base64'))
        } catch {
          /* locked OS store; do not expose ciphertext */
        }
      }
    service = new AssistantService({
      ...deps,
      store,
      settings: initial,
      keys: () => keys,
      save: (s) => store.saveSettings(s),
      provider: new LumaAssistantProvider(() => keys, net.fetch.bind(net) as typeof fetch),
    })
  } catch (error) {
    store.close()
    throw error
  }
  return {
    service,
    setKey(field: unknown, value: unknown) {
      if (
        !['llmKey', 'speechAppKey', 'speechToken'].includes(field as string) ||
        typeof value !== 'string' ||
        value.length > 4096 ||
        /[\r\n]/.test(value)
      )
        throw new Error('密钥格式无效')
      if (!secureAvailable()) throw new Error('系统加密存储不可用，未保存密钥')
      const key = field as AssistantSecret,
        stored = read(keysPath)
      const provider = service.snapshot().settings.provider
      const slot = key === 'llmKey' ? 'llm:' + provider : key
      if (value.trim()) stored[slot] = safeStorage.encryptString(value.trim()).toString('base64')
      else delete stored[slot]
      if (key === 'llmKey') delete stored.llmKey
      write(keysPath, stored)
      if (key === 'llmKey') keys.llmKeys![provider] = value.trim()
      else keys[key] = value.trim()
      deps.changed()
      return service.snapshot()
    },
    close() {
      service.stop()
      store.close()
    },
  }
}
