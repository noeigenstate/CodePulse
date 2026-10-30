/** The 400 x 300 e-paper preview, drawn so each device pixel covers a whole number of physical pixels. */
export const DEVICE_SCREEN_WIDTH = 400
export const DEVICE_SCREEN_HEIGHT = 300

export interface DevicePreviewScale {
  /** Physical pixels per device pixel. */
  k: number
  /** Canvas CSS size; `cssWidth * dpr` is exactly `400 * k`. */
  cssWidth: number
  cssHeight: number
}

const scaleFor = (k: number, dpr: number): DevicePreviewScale => ({
  k,
  cssWidth: (DEVICE_SCREEN_WIDTH * k) / dpr,
  cssHeight: (DEVICE_SCREEN_HEIGHT * k) / dpr,
})
const safeDpr = (dpr: number): number => (Number.isFinite(dpr) && dpr > 0 ? dpr : 1)

/**
 * Preview scale: the nearest whole multiple of the physical pixel grid, or the largest one that
 * still fits `availableCssWidth` (never below 1:1, which may then scroll). A fractional scale would
 * make 1-pixel strokes alternate between one and two physical pixels. `fill` takes the largest
 * whole multiple that fits instead, for presentation mode. `availableCssHeight` caps it the same way.
 */
export function devicePreviewScale(
  dpr: number,
  availableCssWidth: number,
  fill = false,
  availableCssHeight = Infinity,
): DevicePreviewScale {
  const ratio = safeDpr(dpr)
  let k =
    fill && Number.isFinite(availableCssWidth)
      ? Math.floor((availableCssWidth * ratio) / DEVICE_SCREEN_WIDTH)
      : Math.round(ratio)
  k = Math.max(1, k)
  while (
    k > 1 &&
    ((DEVICE_SCREEN_WIDTH * k) / ratio > availableCssWidth ||
      (DEVICE_SCREEN_HEIGHT * k) / ratio > availableCssHeight)
  )
    k--
  return scaleFor(k, ratio)
}

/** The 2x inspection view: at least twice the device size, in whole physical pixels. */
export function deviceInspectScale(dpr: number): DevicePreviewScale {
  const ratio = safeDpr(dpr)
  return scaleFor(Math.max(2, Math.round(2 * ratio)), ratio)
}

/** Short label such as "1:2 像素": one device pixel is `k` physical pixels. */
export const devicePixelRatioLabel = (k: number): string => `1:${k} 像素`
