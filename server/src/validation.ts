import {
  isPluginId,
  isPlainText,
  normalizePluginCard,
  type PluginCard,
  type PluginManifest,
  type PluginSetting,
} from '@codepulse/shared'

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

export function invalid(message = '提交内容无效'): never {
  throw new HttpError(422, message)
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('请提交有效对象')
  return value as Record<string, unknown>
}

export function text(value: unknown, max: number, label: string, allowEmpty = false): string {
  if (!isPlainText(value, max, !allowEmpty)) invalid(`${label}无效`)
  return value
}

export function pluginId(value: unknown): string {
  if (!isPluginId(value)) invalid('插件标识无效')
  return value
}

export function semver(value: unknown): number[] {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    invalid('版本号须为主版本.次版本.修订号')
  const parts = value.split('.').map(Number)
  if (!parts.every(Number.isSafeInteger)) invalid('版本号过大')
  return parts
}

export function newerVersion(next: string, previous: string): boolean {
  const a = semver(next)
  const b = semver(previous)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

function setting(value: unknown): PluginSetting {
  const s = object(value)
  const key = text(s.key, 32, '设置键')
  if (
    !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) ||
    ['constructor', 'prototype', '__proto__'].includes(key)
  )
    invalid('设置键无效')
  const base = { key, label: text(s.label, 24, '设置名称') }
  switch (s.type) {
    case 'text': {
      if (!Number.isInteger(s.maxLength) || Number(s.maxLength) < 1 || Number(s.maxLength) > 400)
        invalid('文字设置长度无效')
      return {
        ...base,
        type: 'text',
        maxLength: s.maxLength as number,
        default: text(s.default, s.maxLength as number, '默认文字', true),
      }
    }
    case 'number': {
      if (
        typeof s.min !== 'number' ||
        !Number.isFinite(s.min) ||
        typeof s.max !== 'number' ||
        !Number.isFinite(s.max) ||
        s.min > s.max ||
        typeof s.default !== 'number' ||
        !Number.isFinite(s.default) ||
        s.default < s.min ||
        s.default > s.max
      )
        invalid('数字设置范围无效')
      return { ...base, type: 'number', min: s.min, max: s.max, default: s.default }
    }
    case 'boolean':
      if (typeof s.default !== 'boolean') invalid('开关默认值无效')
      return { ...base, type: 'boolean', default: s.default }
    case 'select': {
      if (!Array.isArray(s.options) || s.options.length < 1 || s.options.length > 20)
        invalid('选项数量无效')
      const options = s.options.map((raw) => {
        const option = object(raw)
        return {
          value: text(option.value, 80, '选项值'),
          label: text(option.label, 24, '选项名称'),
        }
      })
      if (
        new Set(options.map((o) => o.value)).size !== options.length ||
        typeof s.default !== 'string' ||
        !options.some((o) => o.value === s.default)
      )
        invalid('选项默认值或重复值无效')
      return { ...base, type: 'select', options, default: s.default }
    }
    default:
      return invalid('设置类型无效')
  }
}

export function validateManifest(value: unknown, id: string): PluginManifest {
  const m = object(value)
  if (pluginId(m.id) !== id) invalid('插件标识与路径不一致')
  semver(m.version)
  if (m.kind !== 'pack' && m.kind !== 'webhook') invalid('仅支持内容包和接口插件')
  if (
    !Number.isInteger(m.refreshMinutes) ||
    Number(m.refreshMinutes) < 15 ||
    Number(m.refreshMinutes) > 1440
  )
    invalid('刷新间隔须为15至1440分钟')
  if (!Array.isArray(m.settings) || m.settings.length > 8) invalid('设置项最多8个')
  const settings = m.settings.map(setting)
  if (new Set(settings.map((s) => s.key)).size !== settings.length) invalid('设置键不能重复')
  return {
    id,
    version: m.version as string,
    name: text(m.name, 24, '插件名称'),
    summary: text(m.summary, 60, '插件简介'),
    description: text(m.description, 600, '插件说明', true),
    kind: m.kind,
    refreshMinutes: m.refreshMinutes as number,
    settings,
  }
}

export function validateCards(
  value: unknown,
  now: number,
  expiry: number,
  max: number,
  min = 1,
): PluginCard[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    invalid(`卡片数量须为${min}至${max}张`)
  const cards = value.map((raw) => {
    const input = object(raw)
    const card = normalizePluginCard(
      { ...input, expiresAt: input.expiresAt === undefined ? expiry : input.expiresAt },
      now,
    )
    if (!card) invalid('卡片内容无效')
    return card
  })
  if (new Set(cards.map((c) => c.id)).size !== cards.length) invalid('卡片标识不能重复')
  return cards
}
