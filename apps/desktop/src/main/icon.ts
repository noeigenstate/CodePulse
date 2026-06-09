/**
 * Generates the system-tray icons at runtime. To avoid shipping binary image
 * assets, a tiny PNG encoder draws a solid-colour circle whose colour reflects
 * the aggregated {@link OverallState} (requirements §5.6).
 *
 * @module main/icon
 */
import { deflateSync } from 'node:zlib'
import { nativeImage, type NativeImage } from 'electron'
import type { OverallState } from '@codepulse/shared'

/** Tray colour (RGB) per overall state (requirements §5.6). */
const STATE_COLORS: Record<OverallState, [number, number, number]> = {
  idle: [156, 163, 175], // gray
  running: [59, 130, 246], // blue
  attention: [234, 179, 8], // yellow
  done_unread: [34, 197, 94], // green
  error: [239, 68, 68], // red
  stuck: [249, 115, 18], // orange
}

/** CRC-32 lookup table, built once for PNG chunk checksums. */
const crcTable = buildCrcTable()
/** Cache of generated icons so each colour is encoded at most once. */
const iconCache = new Map<OverallState, NativeImage>()

/**
 * Returns a 16×16 solid-colour tray icon for the given overall state, encoding
 * (and caching) it on first use.
 *
 * @param state The aggregated overall state to represent.
 * @returns An Electron {@link NativeImage} for the tray.
 */
export function trayIconFor(state: OverallState): NativeImage {
  const cached = iconCache.get(state)
  if (cached) return cached
  const [r, g, b] = STATE_COLORS[state]
  const image = nativeImage.createFromBuffer(solidRoundedPng(16, r, g, b))
  iconCache.set(state, image)
  return image
}

/**
 * Encodes a `size`×`size` RGBA PNG containing a filled circle in `(r,g,b)` on a
 * transparent background.
 *
 * @param size Image width/height in pixels.
 * @param r Red channel (0–255).
 * @param g Green channel (0–255).
 * @param b Blue channel (0–255).
 * @returns The encoded PNG bytes.
 */
function solidRoundedPng(size: number, r: number, g: number, b: number): Buffer {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  const cx = (size - 1) / 2
  const cy = (size - 1) / 2
  const radius = size / 2 - 0.5
  let p = 0
  for (let y = 0; y < size; y++) {
    raw[p++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const dist = Math.hypot(x - cx, y - cy)
      const inside = dist <= radius
      raw[p++] = r
      raw[p++] = g
      raw[p++] = b
      raw[p++] = inside ? 255 : 0
    }
  }
  return buildPng(size, size, raw)
}

/**
 * Assembles a complete PNG file from already-filtered raw scanline data.
 *
 * @param width Image width in pixels.
 * @param height Image height in pixels.
 * @param raw Filtered scanlines (each row prefixed with a filter byte).
 * @returns The encoded PNG bytes (signature + IHDR + IDAT + IEND).
 */
function buildPng(width: number, height: number, raw: Buffer): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Wraps chunk data in the PNG length/type/data/CRC framing.
 *
 * @param type The 4-character chunk type (e.g. `"IHDR"`).
 * @param data The chunk payload.
 * @returns The framed chunk bytes.
 */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0)
  return Buffer.concat([length, typeBuf, data, crcBuf])
}

/**
 * Builds the standard CRC-32 lookup table.
 *
 * @returns A 256-entry table of precomputed CRC values.
 */
function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
}

/**
 * Computes the CRC-32 of a buffer using {@link crcTable}.
 *
 * @param buf The bytes to checksum.
 * @returns The unsigned 32-bit CRC.
 */
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
