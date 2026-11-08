import {
  PLUGIN_LOGO_MAX_BYTES,
  PLUGIN_LOGO_MIN_PX,
  PLUGIN_LOGO_MAX_PX,
  type PluginLogoType,
} from './types/plugin.js'

type Dimensions = [number, number]
class LogoError extends Error {}
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function dataView(bytes: Uint8Array): DataView {
  // A subarray can start inside a larger allocation, including a Node Buffer pool.
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function tag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4))
}

function uint24(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + bytes[offset + 1] * 0x100 + bytes[offset + 2] * 0x10000
}

function pngDimensions(bytes: Uint8Array): Dimensions {
  const view = dataView(bytes)
  let dimensions: Dimensions | undefined
  let hasData = false
  for (let offset = 8; offset < bytes.length; ) {
    if (offset + 12 > bytes.length) throw new LogoError('PNG 文件不完整')
    const length = view.getUint32(offset)
    const end = offset + 12 + length
    if (end > bytes.length) throw new LogoError('PNG 文件不完整')
    const kind = tag(bytes, offset + 4)
    if (offset === 8 && (kind !== 'IHDR' || length !== 13)) throw new LogoError('PNG 文件头无效')
    if (kind === 'IHDR') {
      if (dimensions || length !== 13) throw new LogoError('PNG 文件头无效')
      dimensions = [view.getUint32(offset + 8), view.getUint32(offset + 12)]
    }
    if (kind === 'IDAT' && length > 0) hasData = true
    if (kind === 'IEND') {
      if (length !== 0 || end !== bytes.length || !dimensions || !hasData)
        throw new LogoError('PNG 文件不完整')
      return dimensions
    }
    offset = end
  }
  throw new LogoError('PNG 文件不完整')
}

function jpegDimensions(bytes: Uint8Array): Dimensions {
  const view = dataView(bytes)
  let dimensions: Dimensions | undefined
  let inScan = false
  let hasData = false
  let offset = 2
  while (offset < bytes.length) {
    if (inScan && bytes[offset] !== 0xff) {
      hasData = true
      offset++
      continue
    }
    if (bytes[offset++] !== 0xff) throw new LogoError('JPEG 标记无效')
    while (bytes[offset] === 0xff) offset++
    if (offset >= bytes.length) throw new LogoError('JPEG 文件不完整')
    const marker = bytes[offset++]
    if (inScan && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue
    if (marker === 0xd9) {
      if (!dimensions || !hasData || offset !== bytes.length) throw new LogoError('JPEG 文件不完整')
      return dimensions
    }
    inScan = false
    if (marker === 0 || marker === 0xd8 || offset + 2 > bytes.length)
      throw new LogoError('JPEG 标记无效')
    const length = view.getUint16(offset)
    if (length < 2 || offset + length > bytes.length) throw new LogoError('JPEG 文件不完整')
    if (marker === 0xc0 || marker === 0xc2) {
      if (dimensions || length < 8 || length !== 8 + 3 * bytes[offset + 7])
        throw new LogoError('JPEG 文件头无效')
      dimensions = [view.getUint16(offset + 5), view.getUint16(offset + 3)]
    }
    if (marker === 0xda) {
      if (!dimensions || length < 6 || length !== 6 + 2 * bytes[offset + 2])
        throw new LogoError('JPEG 扫描头无效')
      inScan = true
    }
    offset += length
  }
  throw new LogoError('JPEG 文件不完整')
}

function* webpChunks(bytes: Uint8Array, start: number, end: number) {
  const view = dataView(bytes)
  for (let offset = start; offset < end; ) {
    if (offset + 8 > end) throw new LogoError('WebP 文件不完整')
    const length = view.getUint32(offset + 4, true)
    const next = offset + 8 + length + (length % 2)
    if (next > end) throw new LogoError('WebP 文件不完整')
    yield {
      kind: tag(bytes, offset),
      data: bytes.subarray(offset + 8, offset + 8 + length),
    }
    offset = next
  }
}

function webpFrame(kind: string, data: Uint8Array): Dimensions | undefined {
  const view = dataView(data)
  if (kind === 'VP8 ') {
    if (data.length < 10 || data[0] & 1 || data[3] !== 0x9d || data[4] !== 1 || data[5] !== 0x2a)
      throw new LogoError('WebP VP8 文件头无效')
    return [view.getUint16(6, true) & 0x3fff, view.getUint16(8, true) & 0x3fff]
  }
  if (kind === 'VP8L') {
    if (data.length < 5 || data[0] !== 0x2f || data[4] >> 5 !== 0)
      throw new LogoError('WebP VP8L 文件头无效')
    const bits = view.getUint32(1, true)
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]
  }
  return undefined
}

function webpDimensions(bytes: Uint8Array): Dimensions {
  const view = dataView(bytes)
  if (bytes.length < 12 || view.getUint32(4, true) + 8 !== bytes.length)
    throw new LogoError('WebP 文件长度无效')
  let dimensions: Dimensions | undefined
  let hasFrame = false
  for (const { kind, data } of webpChunks(bytes, 12, bytes.length)) {
    if (kind === 'VP8X') {
      if (dimensions || data.length !== 10) throw new LogoError('WebP VP8X 文件头无效')
      dimensions = [uint24(data, 4) + 1, uint24(data, 7) + 1]
    }
    const frame = webpFrame(kind, data)
    if (frame) {
      dimensions ??= frame
      hasFrame = true
    }
    if (kind === 'ANMF') {
      if (!dimensions || data.length < 24) throw new LogoError('WebP 动画帧不完整')
      let hasImage = false
      for (const chunk of webpChunks(data, 16, data.length)) {
        if (webpFrame(chunk.kind, chunk.data)) hasImage = true
      }
      if (!hasImage) throw new LogoError('WebP 动画帧不完整')
      hasFrame = true
    }
  }
  if (!dimensions || !hasFrame) throw new LogoError('WebP 文件不完整')
  return dimensions
}

/** Inspect the file container without a platform image decoder or Node dependencies. */
export function inspectPluginLogo(
  bytes: Uint8Array,
): { type: PluginLogoType; width: number; height: number } | { error: string } {
  if (bytes.length > PLUGIN_LOGO_MAX_BYTES) return { error: '图标不能超过 200 KB' }
  try {
    let type: PluginLogoType
    let dimensions: Dimensions
    if (PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) {
      type = 'image/png'
      dimensions = pngDimensions(bytes)
    } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      type = 'image/jpeg'
      dimensions = jpegDimensions(bytes)
    } else if (tag(bytes, 0) === 'RIFF' && tag(bytes, 8) === 'WEBP') {
      type = 'image/webp'
      dimensions = webpDimensions(bytes)
    } else {
      return { error: '图标文件格式无效' }
    }
    const [width, height] = dimensions
    if (width !== height) return { error: '图标必须是正方形' }
    if (width < PLUGIN_LOGO_MIN_PX || width > PLUGIN_LOGO_MAX_PX)
      return { error: `图标边长须为 ${PLUGIN_LOGO_MIN_PX}–${PLUGIN_LOGO_MAX_PX} 像素` }
    return { type, width, height }
  } catch (error) {
    return { error: error instanceof LogoError ? error.message : '图标文件格式无效' }
  }
}
