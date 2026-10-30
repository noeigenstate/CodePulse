import { createHash } from 'node:crypto'
import { needsHudAttention } from '@codepulse/shared'
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
  if (status.agents.some((a) => !a.taskHidden && needsHudAttention(a))) return '先处理 Agent 提醒'
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
  if (card.kind === 'concept') return config.conceptsEnabled
  if (card.kind === 'prompt') return config.promptsEnabled
  if (card.kind === 'news') return config.newsEnabled && card.score >= 100
  if (card.kind === 'pet') return config.petEnabled && card.pet?.id === config.petId
  if (card.kind === 'image' || card.kind === 'note') return false // Personal content is manual only.
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
        (card.imageHex ?? '') +
        (card.red
          ? `${card.red.x},${card.red.y},${card.red.w}x${card.red.h}:${card.red.hex}`
          : '') +
        // A pet looks the same every day; its id carries the date so it can come back tomorrow.
        (card.kind === 'pet' ? card.id : '') +
        ':' +
        card.text
          .toLowerCase()
          .replace(/https?:\/\/\S+/g, '')
          .replace(/[^\p{L}\p{N}]/gu, ''),
    )
    .digest('hex')
    .slice(0, 24)
}
export function deviceCard(
  card: AmbientCard & Pick<DeviceAmbientCard, 'manual'>,
): DeviceAmbientCard {
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
    ...(card.manual === true ? { manual: true } : {}),
    source: utf8(
      ['x', 'meme', 'news'].includes(card.kind)
        ? `${card.source} · ${card.kind === 'meme' ? '收于 ' : ''}${time}`
        : card.source,
      63,
    ),
    text: utf8(card.text.replace(/https?:\/\/t\.co\/\S+/g, '[链接]'), 767),
    ...(card.imageHex ? { imageHex: card.imageHex } : {}),
    ...(card.items ? { items: card.items.slice(0, 6).map(item => ({ title: utf8(item.title, 159), meta: utf8(item.meta, 47), overdue: item.overdue })) } : {}),
    // Red ink only ever accompanies a bitmap; the card builder guarantees the geometry.
    ...(card.imageHex && card.red ? { red: card.red } : {}),
  }
}
export function withAmbient(
  status: DeviceStatusV1,
  card: (AmbientCard & Pick<DeviceAmbientCard, 'manual'>) | undefined,
): DeviceStatusV1 {
  if (!card) return status
  const project = (ambient: DeviceAmbientCard): DeviceStatusV1 => ({
    ...status,
    ambient,
    revision: createHash('sha256')
      .update(status.revision + JSON.stringify(ambient))
      .digest('hex')
      .slice(0, 24),
  })
  // The MCU's bounded HTTP reader is 32 KiB. A very large quota snapshot may leave no room for
  // the optional red plane: drop it first (black-only still shows the picture), and only if the
  // bitmap itself does not fit preserve the plain work status.
  const fits = (projected: DeviceStatusV1) => Buffer.byteLength(JSON.stringify(projected)) <= 32000
  const ambient = deviceCard(card)
  const full = project(ambient)
  if (fits(full)) return full
  if (ambient.red) {
    const { red: _red, ...blackOnly } = ambient
    const black = project(blackOnly)
    if (fits(black)) return black
  }
  return status
}
