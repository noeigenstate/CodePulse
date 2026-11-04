import { createHash } from 'node:crypto'
import {
  AMBIENT_RED_MAX_BYTES,
  type AmbientCard,
  type AmbientRedPlane,
  type DeviceLife,
} from '@codepulse/shared'
import { CONCEPTS, PROMPTS } from './ambient-reading.js'
import { cleanText } from './ambient-rules.js'

export function builtinCards(now: number): AmbientCard[] {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  const make = (
    id: string,
    kind: AmbientCard['kind'],
    source: string,
    text: string,
    life: DeviceLife,
    url = '',
  ): AmbientCard => ({
    id,
    kind,
    source,
    text,
    url,
    publishedAt: date.getTime(),
    expiresAt: now + 86400000,
    score: 0,
    layout: 'life',
    life,
  })
  // A daily deterministic rotation, without polling or paid generation.
  const offset = Math.floor(date.getTime() / 86400000) % CONCEPTS.length
  const concepts = CONCEPTS.map((c, i) =>
    make(
      'concept:' + c.id,
      'concept',
      `${c.subject} · ${c.term}`,
      `${c.term}：${c.definition}例：${c.example}${c.question}`,
      {
        v: 1,
        kind: 'concept',
        subject: c.subject,
        position: `${i + 1} / ${CONCEPTS.length}`,
        term: c.term,
        english: c.english,
        definition: c.definition,
        example: c.example,
        question: c.question,
      },
      c.url,
    ),
  )
  return [
    ...concepts.map((_, i) => concepts[(i + offset) % concepts.length]!),
    ...PROMPTS.map((p) =>
      make(
        'prompt:' + p.id,
        'prompt',
        '一分钟 · 思考实验',
        p.lead + p.question.join('') + p.follow,
        { v: 1, kind: 'prompt', tag: p.tag, lead: p.lead, question: p.question, follow: p.follow },
      ),
    ),
  ]
}
/** A stored red plane, or undefined when it breaks the protocol (the picture then stays black/white). */
export function validRedPlane(value: unknown): AmbientRedPlane | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { x, y, w, h, hex } = value as Record<string, unknown>
  if (![x, y, w, h].every((v) => Number.isInteger(v))) return undefined
  const [px, py, pw, ph] = [x, y, w, h] as number[]
  if (px! % 8 || pw! % 8 || pw! < 8 || ph! < 1 || px! < 0 || py! < 0) return undefined
  if (px! + pw! > 384 || py! + ph! > 208 || (pw! * ph!) / 8 > AMBIENT_RED_MAX_BYTES)
    return undefined
  if (typeof hex !== 'string' || hex.length !== (pw! * ph!) / 4 || !/^[a-f0-9]+$/.test(hex))
    return undefined
  return { x: px!, y: py!, w: pw!, h: ph!, hex }
}
export function personalCard(
  kind: 'note' | 'image',
  input: unknown,
  now: number,
  imageHex?: string,
  redInput?: unknown,
): AmbientCard {
  if (typeof input !== 'string' || !input.trim() || [...input.trim()].length > 120)
    throw new Error('请填写 1–120 字的内容')
  if (kind === 'image' && (!imageHex || !/^[a-f0-9]{19968}$/.test(imageHex)))
    throw new Error('图片转换失败')
  const text = cleanText(input, 500)
  const red = kind === 'image' ? validRedPlane(redInput) : undefined
  return {
    id:
      kind +
      ':' +
      createHash('sha256')
        .update(text + (imageHex ?? '') + (red ? JSON.stringify(red) : ''))
        .digest('hex')
        .slice(0, 24),
    kind,
    source: kind === 'image' ? '我的图片' : '我的便签',
    text,
    url: '',
    publishedAt: now,
    expiresAt: now + 365 * 86400000,
    score: 0,
    ...(imageHex ? { imageHex } : {}),
    ...(red ? { red } : {}),
  }
}
export function restorePersonalCards(input: unknown, now: number): AmbientCard[] {
  if (!Array.isArray(input)) return []
  return input.slice(0, 8).flatMap((c) => {
    try {
      if (
        !c ||
        !['note', 'image'].includes(c.kind) ||
        !Number.isFinite(c.publishedAt) ||
        c.publishedAt > now
      )
        return []
      const card = personalCard(c.kind, c.text, c.publishedAt, c.imageHex, c.red)
      return card.expiresAt > now ? [card] : []
    } catch {
      return []
    }
  })
}
