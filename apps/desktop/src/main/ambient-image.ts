/** Check encoded dimensions before handing untrusted images to the native decoder. */
export function checkMemeImage(bytes: Uint8Array): void {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0,
    height = 0
  if (
    b.length >= 33 &&
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    b.toString('ascii', 12, 16) === 'IHDR'
  ) {
    width = b.readUInt32BE(16)
    height = b.readUInt32BE(20)
    for (let offset = 8; offset + 12 <= b.length; ) {
      const length = b.readUInt32BE(offset),
        kind = b.toString('ascii', offset + 4, offset + 8)
      if (kind === 'acTL') throw new Error('不支持动态图')
      if (length > b.length - offset - 12) throw new Error('图片数据不完整')
      offset += length + 12
    }
  } else if (b.length >= 4 && b[0] === 255 && b[1] === 216) {
    let offset = 2
    while (offset + 4 <= b.length) {
      if (b[offset++] !== 255) throw new Error('图片格式不支持')
      while (b[offset] === 255) offset++
      const marker = b[offset++]!
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > b.length) break
      const length = b.readUInt16BE(offset)
      if (length < 2 || offset + length > b.length) throw new Error('图片数据不完整')
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        if (length < 7) throw new Error('图片数据不完整')
        height = b.readUInt16BE(offset + 3)
        width = b.readUInt16BE(offset + 5)
        break
      }
      offset += length
    }
  }
  if (!width || !height || width > 8000 || height > 8000 || width * height > 16000000)
    throw new Error('仅支持尺寸适中的 PNG / JPEG 静态图片')
  if (width / height < 1 || width / height > 3) throw new Error('图片过长或过窄，不适合墨水屏')
}

/** Electron's little-endian BGRA bitmap -> fixed, centered 384 x 208 ink plane. */
export function packMemeBitmap(bitmap: Uint8Array, width: number, height: number): string {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    width > 384 ||
    height < 1 ||
    height > 208 ||
    bitmap.length !== width * height * 4
  )
    throw new Error('图片尺寸无效')
  const packed = Buffer.alloc((384 * 208) / 8)
  const left = Math.floor((384 - width) / 2),
    top = Math.floor((208 - height) / 2)
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4,
        alpha = bitmap[i + 3]! / 255
      const grey =
        (0.114 * bitmap[i]! + 0.587 * bitmap[i + 1]! + 0.299 * bitmap[i + 2]!) * alpha +
        255 * (1 - alpha)
      if (grey < 112 + bayer[(y % 4) * 4 + (x % 4)]! * 4) {
        const bit = (y + top) * 384 + x + left
        packed[bit >> 3] = packed[bit >> 3]! | (128 >> (bit & 7))
      }
    }
  return packed.toString('hex')
}
