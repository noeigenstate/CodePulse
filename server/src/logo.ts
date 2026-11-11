import { createHash } from 'node:crypto'
import {
  PLUGIN_LOGO_TYPES,
  PLUGIN_LOGO_MAX_BYTES,
  inspectPluginLogo,
  type PluginLogoType,
} from '@codepulse/shared'
import { invalid, object } from './validation.js'

export interface PluginLogo {
  type: PluginLogoType
  bytes: Buffer
  hash: string
}

export function logoUrl(id: string, hash: string | null): string | null {
  return hash ? `/api/v1/plugins/${id}/logo?v=${hash.slice(0, 12)}` : null
}

export function validateLogo(value: unknown): PluginLogo {
  const body = object(value)
  if (!PLUGIN_LOGO_TYPES.includes(body.type as PluginLogoType))
    invalid('图标仅支持 PNG、JPEG 或 WebP')
  if (typeof body.data !== 'string' || !body.data.length) invalid('图标数据无效')
  if (body.data.length > 4 * Math.ceil(PLUGIN_LOGO_MAX_BYTES / 3)) invalid('图标不能超过 200 KB')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data))
    invalid('图标须为有效 base64 数据')
  const bytes = Buffer.from(body.data, 'base64')
  if (bytes.toString('base64') !== body.data) invalid('图标须为有效 base64 数据')
  const result = inspectPluginLogo(bytes)
  if ('error' in result) invalid(result.error)
  if (result.type !== body.type) invalid('图标类型与文件内容不一致')
  return { type: result.type, bytes, hash: createHash('sha256').update(bytes).digest('hex') }
}
