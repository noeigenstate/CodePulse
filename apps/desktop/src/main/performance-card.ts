import { createHash } from 'node:crypto'
import { toDeviceStatusV1 } from '@codepulse/core'
import {
  normalizeDeviceDisplay,
  normalizePerformanceOptions,
  type DeviceAmbientCard,
  type DeviceStatusV1,
  type InkPerformanceOptions,
  type PerformancePreview,
} from '@codepulse/shared'
import fontData from './performance-font.generated.json'
import type { PerformanceReading, GpuReading } from './performance-collector.js'

const WIDTH = 384,
  HEIGHT = 208,
  GIB = 2 ** 30
type Face = keyof typeof fontData
type Glyph = [number, number, number, number, number, Buffer]
const faces = new Map<Face, Map<string, Glyph>>()
function face(key: Face) {
  let result = faces.get(key)
  if (!result) {
    result = new Map()
    for (const [ch, record] of Object.entries(fontData[key])) {
      const [advance, left, top, w, h, bits] = record as [
        number,
        number,
        number,
        number,
        number,
        string,
      ]
      result.set(ch, [advance, left, top, w, h, Buffer.from(bits, 'base64')])
    }
    faces.set(key, result)
  }
  return result
}

class Bitmap {
  readonly data = Buffer.alloc((WIDTH * HEIGHT) / 8)
  dot(x: number, y: number) {
    if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return
    const i = y * WIDTH + x
    this.data[i >> 3]! |= 128 >> (i & 7)
  }
  rect(x: number, y: number, w: number, h: number) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.dot(x + i, y + j)
  }
  text(
    x: number,
    y: number,
    str: string,
    key: Face = 'label',
    align: 'left' | 'right' | 'center' = 'left',
  ) {
    const font = face(key)
    const glyphs = [...str].map((ch) => font.get(ch) ?? font.get('-')!)
    const width = glyphs.reduce((w, g) => w + g[0], 0)
    const top = Math.min(...glyphs.filter((g) => g[3] && g[4]).map((g) => g[2]))
    let pen = x - (align === 'right' ? width : align === 'center' ? Math.floor(width / 2) : 0)
    for (const [advance, left, dy, w, h, bytes] of glyphs) {
      const stride = Math.ceil(w / 8)
      for (let j = 0; j < h; j++)
        for (let i = 0; i < w; i++)
          if (bytes[j * stride + (i >> 3)]! & (128 >> (i & 7)))
            this.dot(pen + left + i, y + dy - top + j)
      pen += advance
    }
  }
  bar(x: number, y: number, w: number, h: number, value: number | null) {
    if (value === null) return
    for (let i = 0; i < w; i += 4) this.dot(x + i, y + h - 1)
    if (value > 0) this.rect(x, y, Math.max(2, Math.round((w * value) / 100)), h)
  }
}

function orderedGpus(gpus: GpuReading[]): GpuReading[] {
  return [...gpus].sort(
    (a, b) =>
      Number(b.engine === 'CUDA') - Number(a.engine === 'CUDA') ||
      b.total - a.total ||
      a.id.localeCompare(b.id),
  )
}
function selected(s: PerformanceReading, id: string) {
  return id === 'auto' ? orderedGpus(s.gpus)[0] : s.gpus.find((g) => g.id === id)
}
const percent = (n: number | null | undefined) => (n == null ? '--' : String(n) + '%')
const ratio = (used: number | null | undefined, total: number | undefined) =>
  used != null && total && total > 0 ? Math.min(100, Math.round((100 * used) / total)) : null
const gib = (n: number) => (n / GIB).toFixed(1).replace(/\.0$/, '')
const capacity = (used: number | null | undefined, total: number | undefined) =>
  used == null || !total ? '--' : gib(used) + '/' + gib(total) + ' GiB'
const names = { detail: '逐核明细', balanced: '均衡总览', gpu: 'GPU 优先' }
export function makePerformanceCard(
  s: PerformanceReading,
  o: InkPerformanceOptions,
): DeviceAmbientCard {
  const b = new Bitmap(),
    gpu = selected(s, o.gpu)
  const cpu = s.cpu,
    ram = ratio(s.used, s.total),
    vram = ratio(gpu?.used, gpu?.total)
  const compute = gpu?.compute ?? null,
    graphics = gpu?.graphics ?? null,
    engine = gpu?.engine ?? 'Compute'
  const memory = capacity(s.used, s.total),
    video = capacity(gpu?.used, gpu?.total)
  const pages = Math.max(1, Math.ceil(s.cores.length / 20)),
    offset = Math.min(pages - 1, o.page) * 20
  const cores = s.cores.slice(offset, offset + 20)
  function grid(x: number, y: number, dx: number, dy: number, cols: number, w: number) {
    cores.forEach((val, i) => {
      const xx = x + (i % cols) * dx,
        yy = y + Math.floor(i / cols) * dy
      b.text(xx + Math.floor(w / 2), yy, String(i + offset).padStart(2, '0'), 'label', 'center')
      b.bar(xx, yy + 14, w, 5, val)
    })
  }
  if (o.layout === 'detail') {
    b.text(4, 6, String(s.cores.length) + ' 个逻辑核')
    b.text(211, 8, 'CPU 总占用')
    b.text(380, 0, percent(cpu), 'large', 'right')
    cores.forEach((val, i) => {
      const x = 4 + (i % 4) * 96,
        y = 34 + Math.floor(i / 4) * 23
      b.text(x, y + 1, '#' + String(i + offset).padStart(2, '0'))
      b.text(x + 84, y, percent(val), 'number', 'right')
      b.bar(x, y + 15, 84, 4, val)
    })
    b.rect(4, 151, 376, 1)
    b.text(4, 159, '内存')
    b.text(186, 160, memory + ' ' + percent(ram), 'label', 'right')
    b.text(199, 159, '显存')
    b.text(380, 160, video + ' ' + percent(vram), 'label', 'right')
    b.text(4, 184, engine)
    b.bar(72, 191, 60, 5, compute)
    b.text(186, 182, percent(compute), 'number', 'right')
    b.text(199, 184, '3D')
    b.bar(239, 191, 82, 5, graphics)
    b.text(380, 182, percent(graphics), 'number', 'right')
  } else if (o.layout === 'balanced') {
    b.text(4, 2, 'CPU 总占用')
    b.text(199, 2, '内存')
    b.text(380, 3, memory, 'label', 'right')
    b.text(4, 22, percent(cpu), 'large')
    b.text(199, 22, percent(ram), 'large')
    b.bar(4, 57, 177, 5, cpu)
    b.bar(199, 57, 181, 5, ram)
    b.text(4, 70, String(s.cores.length) + ' 个逻辑核')
    grid(9, 89, 38, 26, 10, 27)
    b.rect(4, 143, 376, 1)
    b.text(4, 152, engine)
    b.text(128, 152, '3D')
    b.text(199, 152, '显存')
    b.text(4, 173, percent(compute), 'number')
    b.text(128, 173, percent(graphics), 'number')
    b.text(199, 174, video)
    b.text(380, 173, percent(vram), 'number', 'right')
    b.bar(4, 195, 106, 5, compute)
    b.bar(128, 195, 53, 5, graphics)
    b.bar(199, 195, 181, 5, vram)
  } else {
    b.rect(171, 2, 1, 199)
    b.text(4, 2, engine + ' 计算')
    b.text(3, 23, percent(compute), 'hero')
    b.bar(4, 70, 151, 7, compute)
    b.text(4, 91, '显存')
    b.text(155, 91, percent(vram), 'number', 'right')
    b.text(4, 112, video)
    b.bar(4, 134, 151, 6, vram)
    b.text(4, 160, '3D 引擎')
    b.text(155, 159, percent(graphics), 'number', 'right')
    b.bar(4, 186, 151, 5, graphics)
    b.text(187, 2, 'CPU 总占用')
    b.text(380, 1, percent(cpu), 'number', 'right')
    b.text(187, 26, String(s.cores.length) + ' 个逻辑核')
    grid(188, 48, 39, 25, 5, 27)
    b.rect(187, 151, 193, 1)
    b.text(187, 161, '内存')
    b.text(380, 160, percent(ram), 'number', 'right')
    b.text(187, 184, memory)
    b.bar(303, 192, 77, 5, ram)
  }
  const model = s.model
    .replace(/\(R\)|\(TM\)/gi, '')
    .replace(/\b(?:Intel|AMD|CPU|Processor)\b/gi, '')
    .replace(/\s+@.*|\d+-Core.*|\d+(?:st|nd|rd|th) Gen /gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  const adapter =
    gpu?.name.replace(/\b(NVIDIA|GeForce|AMD|Radeon\(TM\))\s*/gi, '').trim() || 'GPU --'
  const slot = s.gpus.length > 1 && gpu?.id.startsWith('pci-') ? ' [' + gpu.id.slice(4) + ']' : ''
  const text = (
    model.slice(0, 21) +
    ' / ' +
    adapter.slice(0, Math.max(10, 23 - slot.length)) +
    slot
  ).trim()
  const source =
    '电脑性能 · ' + names[o.layout] + (pages > 1 ? ' · ' + (offset / 20 + 1) + '/' + pages : '')
  const id =
    'perf-' +
    createHash('sha256').update(b.data).update(source).update(text).digest('hex').slice(0, 18)
  return { id, source, text, imageHex: b.data.toString('hex') }
}

const change = (a: number | null | undefined, b: number | null | undefined, step: number) =>
  a == null || b == null ? a !== b : Math.abs(a - b) >= step
export function meaningful(
  a: PerformanceReading,
  b: PerformanceReading,
  o: InkPerformanceOptions,
): boolean {
  const g = selected(a, o.gpu),
    h = selected(b, o.gpu)
  if (
    a.model !== b.model ||
    a.cores.length !== b.cores.length ||
    g?.id !== h?.id ||
    g?.engine !== h?.engine ||
    a.total !== b.total ||
    g?.total !== h?.total ||
    change(a.cpu, b.cpu, 5) ||
    change(g?.compute, h?.compute, 5) ||
    change(g?.graphics, h?.graphics, 5) ||
    change(a.used, b.used, Math.min(GIB, a.total * 0.02)) ||
    change(g?.used, h?.used, Math.max(64 * 2 ** 20, (g?.total ?? 0) * 0.02))
  )
    return true
  const offset = Math.min(o.page, Math.max(0, Math.ceil(b.cores.length / 20) - 1)) * 20
  return b.cores
    .slice(offset, offset + 20)
    .some(
      (val, i) =>
        change(a.cores[offset + i], val, 12) ||
        (a.cores[offset + i] === 0 && (val ?? 0) >= 5) ||
        (val === 0 && (a.cores[offset + i] ?? 0) >= 5),
    )
}

/** Cache the actual wire payload. Repeated long polls never redraw or rehash unchanged pixels. */
export class PerformanceFrames {
  private previous?: {
    data: PerformanceReading
    options: string
    at: number
    card: DeviceAmbientCard
  }
  get(
    data: PerformanceReading,
    o: InkPerformanceOptions,
    at: number,
    physical: boolean,
  ): DeviceAmbientCard {
    const key = JSON.stringify(o),
      last = this.previous
    if (
      last?.options === key &&
      (last.data === data ||
        (physical && (at - last.at < 60_000 || !meaningful(last.data, data, o))))
    )
      return last.card
    const card = makePerformanceCard(data, o)
    this.previous = { data, options: key, at, card }
    return card
  }
}

/** A local preview uses the device's projection with no live work to interrupt the card. */
export function makePerformancePreview(
  data: PerformanceReading | undefined,
  options: unknown,
  display: unknown,
  frames: PerformanceFrames,
): PerformancePreview {
  if (!data) return { gpus: [], pages: 0, warming: false }
  const base = toDeviceStatusV1(
    { overall: 'idle', agents: [], updatedAt: 0 },
    normalizeDeviceDisplay(display),
  )
  const card = frames.get(data, normalizePerformanceOptions(options), Date.now(), false)
  return {
    status: attachPerformance(base, card),
    gpus: orderedGpus(data.gpus).map(({ id, name }) => ({ id, name })),
    pages: Math.ceil(data.cores.length / 20),
    warming: data.cpu === null && data.cores.length > 0,
  }
}

export function attachPerformance(status: DeviceStatusV1, card: DeviceAmbientCard): DeviceStatusV1 {
  const revision = createHash('sha256')
    .update(status.revision + card.id)
    .digest('hex')
    .slice(0, 24)
  const result = { ...status, revision, ambient: card }
  // The bitmap is ASCII hex; measuring the work envelope avoids serializing it on every poll.
  const overhead = Buffer.byteLength(JSON.stringify({ ...card, imageHex: '' })) + 32
  return Buffer.byteLength(JSON.stringify(status)) + overhead + (card.imageHex?.length ?? 0) <=
    32000
    ? result
    : status
}
