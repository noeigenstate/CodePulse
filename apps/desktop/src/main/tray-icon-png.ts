import { deflateSync } from 'node:zlib'
import type { OverallState } from '@codepulse/shared'

const STATE_COLORS: Record<OverallState, [number, number, number]> = {
  idle: [148, 163, 184],
  running: [59, 130, 246],
  attention: [234, 179, 8],
  done_unread: [34, 197, 94],
  error: [239, 68, 68],
  stuck: [249, 115, 18],
  limited: [239, 68, 68],
}

const crcTable = buildCrcTable()

/** Subsamples per axis; 4×4 keeps the rim and pulse smooth at 16–32 px. */
const SUPERSAMPLE = 4

/**
 * Pulse waveform from `build/icon.png` / `codepulse-icon.svg`, in unit
 * coordinates of the icon square.
 */
const PULSE_POINTS: ReadonlyArray<readonly [number, number]> = [
  [0.24, 0.51],
  [0.38, 0.51],
  [0.425, 0.415],
  [0.5, 0.64],
  [0.58, 0.32],
  [0.64, 0.51],
  [0.76, 0.51],
]

type Rgba = [number, number, number, number]

/**
 * Renders the tray icon: the CodePulse app logo (black badge, gold rim, gold
 * pulse) plus a status dot for non-idle states.
 *
 * @param state Aggregate dashboard state that picks the dot color.
 * @param size Square edge length in pixels.
 * @returns PNG-encoded RGBA image.
 */
export function trayIconPngFor(state: OverallState, size = 32): Buffer {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  const dot = state === 'idle' ? undefined : STATE_COLORS[state]
  let p = 0

  for (let y = 0; y < size; y++) {
    raw[p++] = 0
    for (let x = 0; x < size; x++) {
      // Average premultiplied subsamples so edges anti-alias against transparency.
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const u = (x + (sx + 0.5) / SUPERSAMPLE) / size
          const v = (y + (sy + 0.5) / SUPERSAMPLE) / size
          const [cr, cg, cb, ca] = logoSample(u, v, dot, size)
          r += cr * ca
          g += cg * ca
          b += cb * ca
          a += ca
        }
      }
      raw[p++] = a > 0 ? Math.round(r / a) : 0
      raw[p++] = a > 0 ? Math.round(g / a) : 0
      raw[p++] = a > 0 ? Math.round(b / a) : 0
      raw[p++] = Math.round((a / (SUPERSAMPLE * SUPERSAMPLE)) * 255)
    }
  }

  return buildPng(size, size, raw)
}

/**
 * Colors one point of the logo.
 *
 * @param u Horizontal unit coordinate.
 * @param v Vertical unit coordinate.
 * @param dot Status dot color, or `undefined` when idle.
 * @param size Output size; thin features widen slightly at tray sizes.
 * @returns Straight RGBA with alpha in 0–1.
 */
function logoSample(
  u: number,
  v: number,
  dot: [number, number, number] | undefined,
  size: number,
): Rgba {
  const dotCx = 0.8
  const dotCy = 0.8
  const dotR = 0.17
  const dotDistance = Math.hypot(u - dotCx, v - dotCy)
  if (dot) {
    if (dotDistance <= dotR) return [dot[0], dot[1], dot[2], 1]
    // A transparent gap keeps the dot readable against the gold rim.
    if (dotDistance <= dotR + 0.06) return [0, 0, 0, 0]
  }

  const distance = Math.hypot(u - 0.5, v - 0.5)
  const outer = 0.47
  // Rim and stroke are proportionally thicker when tiny so they survive downscaling.
  const rim = size <= 32 ? 0.085 : 0.05
  if (distance > outer) return [0, 0, 0, 0]
  if (distance > outer - rim) {
    // Gold rim lit from the upper left, deepening toward the lower right.
    const t = Math.min(1, Math.max(0, (u + v) / 2))
    return [lerp(255, 185, t), lerp(214, 107, t), lerp(90, 5, t), 1]
  }

  const stroke = size <= 32 ? 0.05 : 0.03
  if (distanceToPolyline(u, v, PULSE_POINTS) <= stroke) {
    return [255, lerp(221, 190, u), lerp(87, 46, u), 1]
  }

  // Near-black face with a faint upper-left sheen, as in the app icon.
  const sheen = Math.max(0, 1 - Math.hypot(u - 0.35, v - 0.3) / 0.6)
  const base = 24 + Math.round(sheen * 12)
  return [base, base, base + 3, 1]
}

/**
 * Linear interpolation rounded to a byte.
 * @param from Value at t=0.
 * @param to Value at t=1.
 * @param t Position in 0–1.
 * @returns Interpolated channel value.
 */
function lerp(from: number, to: number, t: number): number {
  return Math.round(from + (to - from) * t)
}

/**
 * Shortest distance from a point to an open polyline.
 * @param x Point x.
 * @param y Point y.
 * @param points Polyline vertices.
 * @returns Distance in the same units as the inputs.
 */
function distanceToPolyline(
  x: number,
  y: number,
  points: ReadonlyArray<readonly [number, number]>,
): number {
  let best = Infinity
  for (let i = 0; i + 1 < points.length; i++) {
    const [x1, y1] = points[i]!
    const [x2, y2] = points[i + 1]!
    best = Math.min(best, distanceToSegment(x, y, x1, y1, x2, y2))
  }
  return best
}

function distanceToSegment(
  x: number,
  y: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSquared = dx * dx + dy * dy
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared))
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
}

function buildPng(width: number, height: number, raw: Buffer): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0)
  return Buffer.concat([length, typeBuf, data, crcBuf])
}

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
