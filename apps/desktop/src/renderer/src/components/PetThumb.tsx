import { useEffect, useRef, useState } from 'react'
import type { AmbientCard } from '@codepulse/shared'
import { planesToRgba } from '../device-preview/renderer.mjs'

const PET_CROP = { x: 4, y: 8, w: 232, h: 196 }
/**
 * The picture-area crop of a 400 x 300 frame with each ink pixel (not white) also painted on its
 * paper neighbours. Red goes first so black wins where the two meet, as on the screen.
 */
function thickenInk(frame: ImageData, crop: typeof PET_CROP): ImageData {
  const left = 8 + crop.x,
    top = 60 + crop.y
  const source = new Uint8ClampedArray(crop.w * crop.h * 4)
  for (let y = 0; y < crop.h; y++)
    source.set(
      frame.data.subarray(((top + y) * 400 + left) * 4, ((top + y) * 400 + left + crop.w) * 4),
      y * crop.w * 4,
    )
  const out = new Uint8ClampedArray(source)
  const isInk = (i: number) => source[i] !== 255 || source[i + 1] !== 255 || source[i + 2] !== 255
  const isBlack = (i: number) => source[i] === 0 && source[i + 1] === 0 && source[i + 2] === 0
  for (const black of [false, true])
    for (let y = 0; y < crop.h; y++)
      for (let x = 0; x < crop.w; x++) {
        const i = (y * crop.w + x) * 4
        if (!isInk(i) || isBlack(i) !== black) continue
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx,
              ny = y + dy
            if (nx < 0 || ny < 0 || nx >= crop.w || ny >= crop.h) continue
            const j = (ny * crop.w + nx) * 4
            if (isInk(j)) continue
            if (!black && (out[j] !== 255 || out[j + 1] !== 255 || out[j + 2] !== 255)) continue
            out.set(source.subarray(i, i + 4), j)
          }
      }
  return new ImageData(out, crop.w, crop.h)
}
/** Thumbnail width in CSS px; the canvas itself is sized in device pixels so edges stay smooth. */
const PET_THUMB_W = 64
const PET_THUMB_H = (PET_THUMB_W * PET_CROP.h) / PET_CROP.w
/**
 * Small look at a pet card's bitmap. It lays the card into the same two planes the device uses
 * and paints them with the shared preview colours, so black wins over red exactly as on the screen.
 * The crop is cut at native size, every ink pixel is grown by one pixel (black over red, never over
 * paper that another colour owns), and only then is it scaled with smoothing to the target size:
 * the 2 to 3 px outlines would otherwise average with the paper and break into dashes.
 */
export function PetThumb({ card }: { card: AmbientCard }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [ratio, setRatio] = useState(() => window.devicePixelRatio || 1)
  useEffect(() => {
    const update = () => setRatio(window.devicePixelRatio || 1)
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  useEffect(() => {
    const target = canvas.current
    const context = target?.getContext('2d')
    if (!target || !context || !card.imageHex) return
    const black = new Uint8Array(15000).fill(0xff),
      red = new Uint8Array(15000).fill(0xff)
    // Picture area origin on the 400 x 300 screen is (8, 60); a set bit is ink, a cleared bit is paint.
    const lay = (plane: Uint8Array, hex: string, width: number, left: number, top: number) => {
      for (let i = 0; i < hex.length / 2; i++) {
        const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
        if (!byte) continue
        for (let bit = 0; bit < 8; bit++)
          if (byte & (0x80 >> bit)) {
            const n = i * 8 + bit,
              pixel = (60 + top + Math.floor(n / width)) * 400 + 8 + left + (n % width)
            plane[pixel >> 3] = plane[pixel >> 3]! & ~(0x80 >> (pixel & 7))
          }
      }
    }
    lay(black, card.imageHex, 384, 0, 0)
    if (card.red) lay(red, card.red.hex, card.red.w, card.red.x, card.red.y)
    const image = new ImageData(new Uint8ClampedArray(planesToRgba(black, red)), 400, 300)
    // Native-size crop on an offscreen canvas, so smoothing never blends in the rest of the screen.
    const crop = document.createElement('canvas')
    crop.width = PET_CROP.w
    crop.height = PET_CROP.h
    crop.getContext('2d')?.putImageData(thickenInk(image, PET_CROP), 0, 0)
    target.width = Math.round(PET_THUMB_W * ratio)
    target.height = Math.round(PET_THUMB_H * ratio)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.fillStyle = '#fff'
    context.fillRect(0, 0, target.width, target.height)
    context.drawImage(crop, 0, 0, target.width, target.height)
  }, [card.imageHex, card.red, ratio])
  return (
    <canvas ref={canvas} style={{ width: PET_THUMB_W, height: PET_THUMB_H }} aria-hidden="true" />
  )
}
