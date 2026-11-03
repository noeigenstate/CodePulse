import { AMBIENT_RED_MAX_BYTES, type AmbientRedPlane } from '@codepulse/shared'

/** Check encoded dimensions before handing untrusted images to the native decoder. */
export function checkMemeImage(bytes: Uint8Array, requireWide = true): void {
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
  if (requireWide && (width / height < 1 || width / height > 3))
    throw new Error('图片过长或过窄，不适合墨水屏')
}

const AREA_W = 384,
  AREA_H = 208
/** Luminance the eye reads for the panel's red ink, used when diffusing tone error around it. */
const RED_INK_LUMA = 0.42

export interface PackedPicture {
  imageHex: string
  red?: AmbientRedPlane
}

const clamp = (v: number) => Math.min(1, Math.max(0, v))

/** Separable 3-pass box blur, a close stand-in for a Gaussian of the given sigma. */
function blur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2))
  const a = Float32Array.from(src),
    b = new Float32Array(src.length)
  const pass = (from: Float32Array, to: Float32Array, horizontal: boolean) => {
    const outer = horizontal ? h : w,
      inner = horizontal ? w : h
    for (let o = 0; o < outer; o++) {
      const at = (i: number) => {
        const c = Math.min(inner - 1, Math.max(0, i))
        return from[horizontal ? o * w + c : c * w + o]!
      }
      let sum = 0
      for (let i = -r; i <= r; i++) sum += at(i)
      for (let i = 0; i < inner; i++) {
        to[horizontal ? o * w + i : i * w + o] = sum / (2 * r + 1)
        sum += at(i + r + 1) - at(i - r)
      }
    }
  }
  for (let k = 0; k < 3; k++) {
    pass(a, b, true)
    pass(b, a, false)
  }
  return a
}

/**
 * Tone for a 1-bit panel: stretch to the picture's own range, lift the median to mid-grey so a
 * dark photo is not mostly black ink, then add local and fine contrast so small faces keep shape.
 */
function tone(luma: Float32Array, w: number, h: number): Float32Array {
  const histogram = new Uint32Array(256)
  for (const v of luma) histogram[Math.round(clamp(v) * 255)]!++
  const at = (fraction: number) => {
    let seen = 0
    for (let i = 0; i < 256; i++)
      if ((seen += histogram[i]!) >= fraction * luma.length) return i / 255
    return 1
  }
  const lo = at(0.01),
    hi = at(0.995)
  // A flat picture (one colour, a logo on white) keeps its own tone.
  if (hi - lo < 0.05) return Float32Array.from(luma)
  const x = luma.map((v) => clamp((v - lo) / (hi - lo)))
  const median = Float32Array.from(x).sort()[x.length >> 1]!
  const gamma = Math.min(1.6, Math.max(0.35, Math.log(0.5) / Math.log(Math.max(median, 1e-3))))
  for (let i = 0; i < x.length; i++) x[i] = x[i]! ** gamma
  const wide = blur(x, w, h, 12)
  for (let i = 0; i < x.length; i++) x[i] = clamp(x[i]! + 0.6 * (x[i]! - wide[i]!))
  const fine = blur(x, w, h, 1.2)
  for (let i = 0; i < x.length; i++) x[i] = clamp(x[i]! + 1.2 * (x[i]! - fine[i]!))
  return x
}

/** 0..1: how strongly a pixel is a saturated red (hue about 0-16 degrees). Skin and wood drop out. */
function redness(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b),
    chroma = max - Math.min(r, g, b)
  if (r < max || chroma < 1e-3) return 0
  const hue = ((g - b) / chroma) * 60
  return (
    clamp((18 - Math.abs(hue + 2)) / 10) *
    clamp((chroma / max - 0.5) / 0.3) *
    clamp((max - 0.12) / 0.2)
  )
}

type Rect = { x: number; y: number; w: number; h: number }

/** The red rectangle (protocol: x, w multiples of 8; w*h/8 <= 3072 bytes) holding the most red. */
function redRectangle(score: Float32Array): Rect | null {
  const stride = AREA_W + 1,
    sat = new Float64Array(stride * (AREA_H + 1))
  for (let y = 0; y < AREA_H; y++)
    for (let x = 0; x < AREA_W; x++)
      sat[(y + 1) * stride + x + 1] =
        score[y * AREA_W + x]! +
        sat[y * stride + x + 1]! +
        sat[(y + 1) * stride + x]! -
        sat[y * stride + x]!
  const sum = (x: number, y: number, w: number, h: number) =>
    sat[(y + h) * stride + x + w]! -
    sat[y * stride + x + w]! -
    sat[(y + h) * stride + x]! +
    sat[y * stride + x]!
  let best: (Rect & { s: number }) | null = null
  for (let w = 64; w <= AREA_W; w += 8) {
    const h = Math.min(AREA_H, Math.floor((AMBIENT_RED_MAX_BYTES * 8) / w))
    for (let y = 0; y + h <= AREA_H; y += 4)
      for (let x = 0; x + w <= AREA_W; x += 8) {
        const s = sum(x, y, w, h)
        if (!best || s > best.s) best = { x, y, w, h, s }
      }
  }
  // Too little red to be worth a slow three-colour refresh.
  if (!best || best.s < 120) return null
  return { x: best.x, y: best.y, w: best.w, h: best.h }
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

/**
 * Electron's little-endian BGRA bitmap -> centered 384 x 208 picture for the black/white/red panel.
 * Tone-mapped, then Atkinson error diffusion (lighter and crisper than ordered dithering). With
 * `red`, saturated reds inside the best protocol-sized rectangle become red ink; red never overlaps
 * black and its tone is accounted for in the diffusion.
 */
export function packPicture(
  bitmap: Uint8Array,
  width: number,
  height: number,
  options: { red?: boolean } = {},
): PackedPicture {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    width > AREA_W ||
    height < 1 ||
    height > AREA_H ||
    bitmap.length !== width * height * 4
  )
    throw new Error('图片尺寸无效')
  const left = Math.floor((AREA_W - width) / 2),
    top = Math.floor((AREA_H - height) / 2)
  const luma = new Float32Array(width * height),
    reds = new Float32Array(AREA_W * AREA_H),
    visible = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const alpha = bitmap[i * 4 + 3]! / 255
    const channel = (c: number) => (bitmap[i * 4 + c]! / 255) * alpha + (1 - alpha)
    const b = channel(0),
      g = channel(1),
      r = channel(2)
    luma[i] = 0.299 * r + 0.587 * g + 0.114 * b
    visible[i] = alpha > 0 ? 1 : 0
    if (options.red)
      reds[(Math.floor(i / width) + top) * AREA_W + (i % width) + left] = redness(r, g, b)
  }
  const x = tone(luma, width, height)
  const rect = options.red ? redRectangle(reds) : null
  const isRed = (px: number, py: number) => {
    if (!rect) return false
    const ax = px + left,
      ay = py + top
    if (ax < rect.x || ax >= rect.x + rect.w || ay < rect.y || ay >= rect.y + rect.h) return false
    // An ordered threshold keeps red a texture that follows its strength, not a flat blob.
    return reds[ay * AREA_W + ax]! > ((BAYER[(py % 4) * 4 + (px % 4)]! + 0.5) / 16) * 0.9
  }
  const black = Buffer.alloc((AREA_W * AREA_H) / 8)
  const red = rect ? Buffer.alloc((rect.w * rect.h) / 8) : null
  const set = (plane: Buffer, bit: number) => {
    plane[bit >> 3] = plane[bit >> 3]! | (128 >> (bit & 7))
  }
  for (let py = 0; py < height; py++) {
    // Serpentine rows avoid the diagonal drift of one-directional diffusion.
    const d = py % 2 === 0 ? 1 : -1
    for (let n = 0; n < width; n++) {
      const px = d === 1 ? n : width - 1 - n,
        i = py * width + px
      let out = 1
      if (!visible[i]) out = 1
      else if (red && rect && isRed(px, py)) {
        out = RED_INK_LUMA
        set(red, (py + top - rect.y) * rect.w + px + left - rect.x)
      } else if (x[i]! < 0.5) {
        out = 0
        set(black, (py + top) * AREA_W + px + left)
      }
      // Atkinson diffusion spreads 6/8 of the error, so highlights stay clean on a 1-bit panel.
      const e = (x[i]! - out) / 8
      for (const [dx, dy] of [
        [d, 0],
        [2 * d, 0],
        [-d, 1],
        [0, 1],
        [d, 1],
        [0, 2],
      ] as const) {
        const qx = px + dx,
          qy = py + dy
        if (qx >= 0 && qx < width && qy < height) x[qy * width + qx]! += e
      }
    }
  }
  return {
    imageHex: black.toString('hex'),
    ...(rect && red?.some((v) => v) ? { red: { ...rect, hex: red.toString('hex') } } : {}),
  }
}

/** Black-only picture for cards that rotate automatically (red forces a slow full refresh). */
export function packMemeBitmap(bitmap: Uint8Array, width: number, height: number): string {
  return packPicture(bitmap, width, height).imageHex
}
