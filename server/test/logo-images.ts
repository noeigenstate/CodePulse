import { deflateSync } from 'node:zlib'

function pngChunk(kind: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  chunk.write(kind, 4)
  data.copy(chunk, 8)
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  return chunk
}

export function png(width = 64, height = width, shade = 0, padding = 0): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  const pixels = Buffer.alloc((width + 1) * height, shade)
  for (let row = 0; row < height; row++) pixels[row * (width + 1)] = 0
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    ...(padding
      ? [pngChunk('tEXt', Buffer.concat([Buffer.from('p\0'), Buffer.alloc(padding - 2, 65)]))]
      : []),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function jpegSegment(marker: number, data: Buffer): Buffer {
  const header = Buffer.from([0xff, marker, 0, 0])
  header.writeUInt16BE(data.length + 2, 2)
  return Buffer.concat([header, data])
}

export function jpeg(width = 64, height = width, progressive = false): Buffer {
  const frame = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0])
  frame.writeUInt16BE(height, 1)
  frame.writeUInt16BE(width, 3)
  // Single-symbol DC/AC tables encode zero coefficients, yielding a flat gray image.
  const table = (kind: number) => Buffer.from([kind, 1, ...Array<number>(15).fill(0), 0])
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8)
  const scan = (bits: number) => {
    const data = Buffer.alloc(Math.ceil(bits / 8))
    const padding = data.length * 8 - bits
    data[data.length - 1] = (1 << padding) - 1
    return data
  }
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xdb, Buffer.from([0, ...Array<number>(64).fill(1)])),
    jpegSegment(progressive ? 0xc2 : 0xc0, frame),
    jpegSegment(0xc4, Buffer.concat([table(0), table(0x10)])),
    jpegSegment(0xda, Buffer.from([1, 1, 0, 0, progressive ? 0 : 63, 0])),
    scan(blocks * (progressive ? 1 : 2)),
    ...(progressive ? [jpegSegment(0xda, Buffer.from([1, 1, 0, 1, 63, 0])), scan(blocks)] : []),
    Buffer.from([0xff, 0xd9]),
  ])
}

export function webpChunk(kind: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(8 + data.length + (data.length % 2))
  chunk.write(kind)
  chunk.writeUInt32LE(data.length, 4)
  data.copy(chunk, 8)
  return chunk
}

export function webpContainer(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks])
  const header = Buffer.from('RIFF0000')
  header.writeUInt32LE(body.length, 4)
  return Buffer.concat([header, body])
}

export function webp(kind: 'VP8 ' | 'VP8L' | 'VP8X' = 'VP8L', width = 64, height = width): Buffer {
  if (kind === 'VP8 ') {
    const frame = Buffer.from([0x90, 3, 0, 0x9d, 1, 0x2a, 0, 0, 0, 0])
    frame.writeUInt16LE(width, 6)
    frame.writeUInt16LE(height, 8)
    // Compressed coefficients for a constant 64×64 key frame.
    const coefficients = Buffer.from(
      '3e9148a44d25a423a2220800b0120969000013e842e300ba9a788000e44000000000',
      'hex',
    )
    return webpContainer(webpChunk('VP8 ', Buffer.concat([frame, coefficients])))
  }
  const bits: number[] = []
  const put = (value: number, count: number) => {
    for (let i = 0; i < count; i++) bits.push((value >>> i) & 1)
  }
  put(0, 3) // No transforms, color cache or meta Huffman image.
  for (const value of [0, 0, 0, 255, 0]) {
    put(1, 1)
    put(0, 1)
    put(value > 1 ? 1 : 0, 1)
    put(value, value > 1 ? 8 : 1)
  }
  const compressed = Buffer.alloc(Math.ceil(bits.length / 8))
  bits.forEach((bit, i) => {
    compressed[i >>> 3] |= bit << (i % 8)
  })
  const header = Buffer.alloc(5)
  header[0] = 0x2f
  header.writeUInt32LE((width - 1) | ((height - 1) << 14), 1)
  const lossless = webpChunk('VP8L', Buffer.concat([header, compressed]))
  if (kind === 'VP8L') return webpContainer(lossless)
  const canvas = Buffer.alloc(10)
  canvas.writeUIntLE(width - 1, 4, 3)
  canvas.writeUIntLE(height - 1, 7, 3)
  return webpContainer(webpChunk('VP8X', canvas), lossless)
}
