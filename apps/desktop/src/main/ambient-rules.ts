import { createHash } from 'node:crypto'
import type {
  AmbientCard,
  AmbientConfig,
  DeviceAmbientCard,
  DeviceStatusV1,
  StatusSnapshot,
} from '@codepulse/shared'

export function cleanText(value: unknown, max = 1200): string {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : ''
}
export function inQuietHours(config: AmbientConfig, now: number): boolean {
  const hour = new Date(now).getHours(),
    { quietStart: start, quietEnd: end } = config
  return start !== end && (start < end ? hour >= start && hour < end : hour >= start || hour < end)
}
export function pauseReason(config: AmbientConfig, status: StatusSnapshot, now: number): string {
  if (!config.enabled) return '桌边动态已关闭'
  if (inQuietHours(config, now)) return '安静时段'
  if (
    status.agents.some(
      (a) =>
        !a.taskHidden &&
        (a.needPermission ||
          a.needUserInput ||
          [
            'WAITING_PERMISSION',
            'WAITING_USER_INPUT',
            'ERROR',
            'TIMEOUT',
            'USAGE_LIMITED',
          ].includes(a.state) ||
          (a.unread && a.state === 'DONE')),
    )
  )
    return '先处理 Agent 提醒'
  if (
    config.idleOnly &&
    status.agents.some(
      (a) => !a.taskHidden && ['PROMPT_SUBMITTED', 'THINKING', 'TOOL_RUNNING'].includes(a.state),
    )
  )
    return '等待 Agent 空闲'
  return ''
}
export function xMinimumLikes(config: AmbientConfig, account: string): number {
  return config.accountMinLikes[account.replace(/^@/, '').toLowerCase()] ?? config.minLikes
}
export function qualifies(card: AmbientCard, config: AmbientConfig, now: number): boolean {
  if (!card.text || card.expiresAt <= now || card.publishedAt > now + 300000) return false
  if (config.exclude.some((w) => card.text.toLowerCase().includes(w.toLowerCase()))) return false
  if (card.kind === 'meme') return config.memeEnabled && card.score >= config.memeMinUps
  return (
    config.xEnabled &&
    card.score >= xMinimumLikes(config, card.source) &&
    card.text.replace(/https?:\/\/\S+/g, '').replace(/[^\p{L}\p{N}]/gu, '').length >= 12 &&
    config.accounts.some((a) => card.source.toLowerCase() === '@' + a.toLowerCase()) &&
    (!config.keywords.length ||
      config.keywords.some((w) => card.text.toLowerCase().includes(w.toLowerCase())))
  )
}
export function contentKey(card: AmbientCard): string {
  return createHash('sha256')
    .update(
      card.kind +
        ':' +
        card.text
          .toLowerCase()
          .replace(/https?:\/\/\S+/g, '')
          .replace(/[^\p{L}\p{N}]/gu, ''),
    )
    .digest('hex')
    .slice(0, 24)
}
export function deviceCard(card: AmbientCard): DeviceAmbientCard {
  const utf8 = (s: string, bytes: number) => {
    let out = ''
    for (const c of s) {
      if (Buffer.byteLength(out + c) > bytes) break
      out += c
    }
    return out
  }
  const date = new Date(card.publishedAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return {
    id: createHash('sha256').update(card.id).digest('hex').slice(0, 24),
    source: utf8(`${card.source} · ${card.kind === 'meme' ? '收于 ' : ''}${time}`, 63),
    text: utf8(card.text.replace(/https?:\/\/t\.co\/\S+/g, '[链接]'), 767),
    ...(card.imageHex ? { imageHex: card.imageHex } : {}),
  }
}
export function withAmbient(status: DeviceStatusV1, card: AmbientCard | undefined): DeviceStatusV1 {
  if (!card) return status
  const ambient = deviceCard(card)
  const projected = {
    ...status,
    ambient,
    revision: createHash('sha256')
      .update(status.revision + JSON.stringify(ambient))
      .digest('hex')
      .slice(0, 24),
  }
  // The MCU's bounded HTTP reader is 32 KiB. Preserve work status if a very
  // large quota snapshot leaves insufficient room for an optional bitmap.
  return Buffer.byteLength(JSON.stringify(projected)) <= 32000 ? projected : status
}
