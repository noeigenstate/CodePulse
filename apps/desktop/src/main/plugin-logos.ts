import { createHash } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  isPluginId,
  inspectPluginLogo,
  PLUGIN_LOGO_MAX_BYTES,
  type PluginLogoType,
} from '@codepulse/shared'
import type { PluginMutationResult } from './plugin-platform.js'

const LOCAL_IDS = new Set(
  'concept prompt pet calendar news social local life tools holiday headlines todo'
    .split(' ')
    .map((category) => `local:${category}`),
)
const extensions: Record<PluginLogoType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}
const validId = (id: unknown): id is string =>
  typeof id === 'string' && (LOCAL_IDS.has(id) || isPluginId(id))
const hashId = (id: string) => createHash('sha256').update(id).digest('hex')

export type PluginLogoPickResult = PluginMutationResult | { cancelled: true }

export class PluginLogoStore {
  private index: Record<string, string> = {}
  private cached?: Record<string, string>
  private readonly directory: string
  private readonly indexPath: string
  constructor(
    directory: string,
    private deps: {
      choose: () => Promise<string | undefined>
      changed: () => void
    },
  ) {
    this.directory = join(directory, 'plugin-logos')
    this.indexPath = join(directory, 'plugin-logos.json')
    try {
      const saved: unknown = JSON.parse(readFileSync(this.indexPath, 'utf8'))
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return
      for (const [id, file] of Object.entries(saved)) {
        if (
          validId(id) &&
          typeof file === 'string' &&
          Object.values(extensions).some((ext) => file === `${hashId(id)}.${ext}`)
        )
          this.index[id] = file
      }
    } catch {
      // An invalid local index never grants access to arbitrary paths.
    }
  }
  private read(path: string): Buffer {
    const file = openSync(path, 'r')
    try {
      const stat = fstatSync(file)
      if (!stat.isFile() || stat.size > PLUGIN_LOGO_MAX_BYTES) throw Error('请选择 200 KB 内的图片')
      // Bound the read even if a selected file grows after its size was checked.
      const bytes = Buffer.alloc(PLUGIN_LOGO_MAX_BYTES + 1)
      let length = 0
      while (length < bytes.length) {
        const count = readSync(file, bytes, length, bytes.length - length, null)
        if (!count) break
        length += count
      }
      if (length > PLUGIN_LOGO_MAX_BYTES) throw Error('请选择 200 KB 内的图片')
      return bytes.subarray(0, length)
    } finally {
      closeSync(file)
    }
  }
  list(): Record<string, string> {
    if (this.cached) return { ...this.cached }
    const logos: Record<string, string> = {}
    for (const [id, file] of Object.entries(this.index)) {
      try {
        const bytes = this.read(join(this.directory, file))
        const logo = inspectPluginLogo(bytes)
        if (!('error' in logo)) logos[id] = `data:${logo.type};base64,${bytes.toString('base64')}`
      } catch {
        // A removed or damaged image falls back to the plugin's default logo.
      }
    }
    this.cached = logos
    return { ...logos }
  }
  private save(index: Record<string, string>): void {
    writeFileSync(this.indexPath + '.tmp', JSON.stringify(index), { mode: 0o600 })
    renameSync(this.indexPath + '.tmp', this.indexPath)
    this.index = index
    this.cached = undefined
  }
  async pick(id: string): Promise<PluginLogoPickResult> {
    if (!validId(id)) return { error: '插件编号无效' }
    try {
      const path = await this.deps.choose()
      if (!path) return { cancelled: true }
      const bytes = this.read(path)
      const logo = inspectPluginLogo(bytes)
      if ('error' in logo) return logo
      const file = `${hashId(id)}.${extensions[logo.type]}`
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      const target = join(this.directory, file)
      writeFileSync(target + '.tmp', bytes, { mode: 0o600 })
      renameSync(target + '.tmp', target)
      const previous = this.index[id]
      if (previous !== file) {
        try {
          this.save({ ...this.index, [id]: file })
        } catch (error) {
          this.removeFile(file)
          throw error
        }
      }
      if (previous && previous !== file) this.removeFile(previous)
      this.cached = undefined
      this.deps.changed()
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      return {
        error: message.startsWith('请选择') ? message : '图标未能保存',
      }
    }
  }
  reset(id: string): { ok: true } {
    if (!validId(id) || !this.index[id]) return { ok: true }
    const file = this.index[id]
    const index = { ...this.index }
    delete index[id]
    this.save(index)
    this.removeFile(file)
    this.deps.changed()
    return { ok: true }
  }
  private removeFile(file: string): void {
    try {
      unlinkSync(join(this.directory, file))
    } catch {
      // The index is authoritative; an already removed file needs no recovery.
    }
  }
}
