import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { nativeImage, safeStorage, net } from 'electron'
import type { AmbientConfig, YuanbaoKeyInput } from '@codepulse/shared'
import { YuanbaoClient, yuanbaoResponseJson } from './ambient-yuanbao.js'
import { YuanbaoKeyStore } from './ambient-yuanbao-keys.js'
import { AmbientService, type AmbientDependencies } from './ambient-service.js'
import { allowedMemeImage, fetchBytes } from './ambient-sources.js'
import { checkMemeImage, packMemeBitmap } from './ambient-image.js'

export function createAmbientRuntime(
  directory: string,
  deps: Pick<AmbientDependencies, 'status' | 'changed' | 'automaticAllowed' | 'plan'>,
) {
  const path = join(directory, 'ambient-settings.json'),
    keysPath = join(directory, 'ambient-keys.json')
  const read = (file: string) => {
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  const saved = read(path)
  const libraryPath = join(directory, 'ambient-library.json')
  const holidaysPath = join(directory, 'calendar-holidays.json')
  const keys: Partial<Record<AmbientConfig['provider'], string>> = {}
  if (safeStorage.isEncryptionAvailable())
    for (const provider of ['x', 'twitterapi'] as const) {
      try {
        const encrypted = read(keysPath)[provider]
        if (typeof encrypted === 'string')
          keys[provider] = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
      } catch {
        /* locked OS key store; do not expose ciphertext */
      }
    }
  const write = (file: string, value: unknown) => {
    writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 })
    renameSync(file + '.tmp', file)
  }
  const yuanbaoKeys = new YuanbaoKeyStore({
    available: () => safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend?.() !== 'basic_text'),
    encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value),
    read: () => read(keysPath), write: value => write(keysPath, value),
  })
  const yuanbaoPath = join(directory, 'yuanbao-cache.json')
  const service = new AmbientService({
    ...deps,
    config: saved.config,
    history: saved.history as import('./ambient-service.js').AmbientHistory | undefined,
    key: (p) => keys[p] ?? '',
    save: (config, history) => write(path, { config, history }),
    library: read(libraryPath).cards,
    saveLibrary: (cards) => write(libraryPath, { cards }),
    holidayCache: read(holidaysPath),
    saveHolidayCache: (cache) => write(holidaysPath, cache),
    yuanbaoKey: () => yuanbaoKeys.get(),
    yuanbaoClient: new YuanbaoClient({ transport: net.fetch.bind(net) }),
    yuanbaoCache: read(yuanbaoPath),
    saveYuanbao: cache => write(yuanbaoPath, cache),
    saveYuanbaoResponse: raw => {
      const path = join(directory, 'yuanbao-last-response.json')
      writeFileSync(path + '.tmp', yuanbaoResponseJson(raw), { encoding: 'utf8', mode: 0o600 })
      renameSync(path + '.tmp', path)
    },
    request: async (url, headers) =>
      JSON.parse(
        Buffer.from(await fetchBytes(url, headers, 512000, net.fetch.bind(net))).toString('utf8'),
      ),
    image: async (url) => {
      if (!allowedMemeImage(url)) throw new Error('不支持的图片地址')
      const bytes = await fetchBytes(url, {}, 4000000, net.fetch.bind(net))
      checkMemeImage(bytes, false)
      const image = nativeImage.createFromBuffer(Buffer.from(bytes)),
        size = image.getSize()
      if (
        image.isEmpty() ||
        size.width > 8000 ||
        size.height > 8000 ||
        size.width * size.height > 16000000
      )
        throw new Error('图片尺寸不支持')
      const scale = Math.min(384 / size.width, 208 / size.height),
        width = Math.max(1, Math.floor(size.width * scale)),
        height = Math.max(1, Math.floor(size.height * scale))
      return packMemeBitmap(
        image.resize({ width, height, quality: 'best' }).toBitmap(),
        width,
        height,
      )
    },
  })
  return {
    service,
    setYuanbaoKey(input: YuanbaoKeyInput) {
      yuanbaoKeys.set(input)
      service.yuanbao.credentialsChanged()
      return service.snapshot()
    },
    importImage(bytes: unknown, name: unknown) {
      if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 8000000)
        throw new Error('请选择 8 MB 内的 PNG / JPEG 图片')
      checkMemeImage(bytes, false)
      const image = nativeImage.createFromBuffer(Buffer.from(bytes)),
        size = image.getSize()
      if (image.isEmpty() || !size.width || !size.height || size.width * size.height > 16000000)
        throw new Error('图片无法读取或尺寸过大')
      const scale = Math.min(384 / size.width, 208 / size.height)
      const width = Math.max(1, Math.floor(size.width * scale)),
        height = Math.max(1, Math.floor(size.height * scale))
      const hex = packMemeBitmap(
        image.resize({ width, height, quality: 'best' }).toBitmap(),
        width,
        height,
      )
      return service.addPersonal(
        'image',
        typeof name === 'string' ? name.slice(0, 100) : '我的图片',
        hex,
      )
    },
    setKey(provider: AmbientConfig['provider'], key: unknown) {
      if (provider !== 'x' && provider !== 'twitterapi') throw new Error('不支持的数据源')
      if (typeof key !== 'string' || key.length > 4096) throw new Error('密钥格式无效')
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用，未保存密钥')
      const stored = read(keysPath)
      if (key.trim()) stored[provider] = safeStorage.encryptString(key.trim()).toString('base64')
      else delete stored[provider]
      write(keysPath, stored)
      keys[provider] = key.trim()
      return service.snapshot()
    },
  }
}
