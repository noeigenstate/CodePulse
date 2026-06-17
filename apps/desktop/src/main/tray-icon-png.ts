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

export function trayIconPngFor(state: OverallState, size = 32): Buffer {
  const [accentR, accentG, accentB] = STATE_COLORS[state]
  const raw = Buffer.alloc(size * (size * 4 + 1))
  const cx = (size - 1) / 2
  const cy = (size - 1) / 2
  const outerRadius = size * 0.45
  const innerRadius = size * 0.37
  let p = 0

  for (let y = 0; y < size; y++) {
    raw[p++] = 0
    for (let x = 0; x < size; x++) {
      const dx = x - cx
      const dy = y - cy
      const distance = Math.hypot(dx, dy)
      let rgba: [number, number, number, number] = [0, 0, 0, 0]

      if (distance <= outerRadius) {
        const shade = Math.max(0, 1 - distance / outerRadius)
        const base = Math.round(236 + shade * 18)
        rgba = [base, Math.min(255, base + 3), 255, 255]
      }

      if (distance > innerRadius && distance <= outerRadius) {
        rgba = blend(rgba, [accentR, accentG, accentB, 60])
      }

      if (onPulsePath(x, y, size) && Math.hypot(x - cx, y - cy) > size * 0.08) {
        rgba = blend(rgba, [245, 158, 11, 255])
      }

      if (state !== 'idle' && Math.hypot(x - size * 0.72, y - size * 0.72) <= size * 0.1) {
        rgba = blend(rgba, [accentR, accentG, accentB, 255])
      }

      raw[p++] = rgba[0]
      raw[p++] = rgba[1]
      raw[p++] = rgba[2]
      raw[p++] = rgba[3]
    }
  }

  return buildPng(size, size, raw)
}

function onPulsePath(x: number, y: number, size: number): boolean {
  const points = [
    [0.22, 0.56],
    [0.34, 0.56],
    [0.4, 0.43],
    [0.48, 0.7],
    [0.56, 0.28],
    [0.64, 0.56],
    [0.78, 0.56],
  ].map(([px, py]) => [px * size, py * size] as const)

  return points.some((point, index) => {
    const next = points[index + 1]
    return next ? distanceToSegment(x, y, point[0], point[1], next[0], next[1]) <= 1.15 : false
  })
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

function blend(
  bottom: [number, number, number, number],
  top: [number, number, number, number],
): [number, number, number, number] {
  const alpha = top[3] / 255
  const inverse = 1 - alpha
  return [
    Math.round(top[0] * alpha + bottom[0] * inverse),
    Math.round(top[1] * alpha + bottom[1] * inverse),
    Math.round(top[2] * alpha + bottom[2] * inverse),
    Math.max(bottom[3], top[3]),
  ]
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
