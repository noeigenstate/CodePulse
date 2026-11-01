/** Pure layout helpers for the dashboard's variable-height project virtual list. */

/** One row's measured or estimated position in the virtual scroll coordinate system. */
export interface VirtualListRow {
  /** End-exclusive bottom offset in pixels. */
  end: number
  /** Index in the caller's input key order. */
  index: number
  /** Stable key used to look up a measured height. */
  key: string
  /** Row height in pixels, excluding the following gap. */
  size: number
  /** Top offset in pixels. */
  start: number
}

/** Complete scroll geometry for a virtual list render pass. */
export interface VirtualListLayout {
  rows: VirtualListRow[]
  /** Scrollable height in pixels; it excludes the final row's trailing gap. */
  totalSize: number
}

/** End-exclusive row index range to mount for a viewport. */
export interface VirtualListRange {
  end: number
  start: number
}

/**
 * Builds deterministic variable-height list geometry from stable row keys.
 *
 * A positive measured size wins over the estimate; invalid measurements fall
 * back to the positive estimate. Negative gaps are clamped to zero and the
 * final gap is excluded from `totalSize`.
 *
 * @param keys Stable row keys in display order.
 * @param measuredSizes Latest ResizeObserver heights keyed by row id.
 * @param estimatedSize Positive fallback height for rows not measured yet.
 * @param gap Desired spacing between adjacent rows in pixels.
 * @returns Row offsets and the total scrollable height.
 */
export function buildVirtualListLayout(
  keys: readonly string[],
  measuredSizes: ReadonlyMap<string, number>,
  estimatedSize: number,
  gap: number,
): VirtualListLayout {
  const rows: VirtualListRow[] = []
  const fallbackSize = positiveSize(estimatedSize, 1)
  const safeGap = Math.max(0, gap)
  let cursor = 0

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!
    const size = positiveSize(measuredSizes.get(key), fallbackSize)
    rows.push({ key, index, start: cursor, size, end: cursor + size })
    cursor += size + safeGap
  }

  return {
    rows,
    totalSize: rows.length > 0 ? cursor - safeGap : 0,
  }
}

/**
 * Finds the end-exclusive row window intersecting an overscanned viewport.
 *
 * `rows` must be sorted by ascending `start`/`end`, as produced by
 * {@link buildVirtualListLayout}. The returned range always mounts at least one
 * row for a non-empty list, allowing the first measurement to occur before the
 * viewport size is known.
 *
 * @param rows Ordered row geometry.
 * @param scrollTop Current vertical scroll offset in pixels.
 * @param viewportHeight Visible viewport height in pixels.
 * @param overscan Extra pixels to mount before and after the viewport.
 * @returns An end-exclusive slice range into `rows`.
 */
export function findVirtualListRange(
  rows: readonly VirtualListRow[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): VirtualListRange {
  if (rows.length === 0) return { start: 0, end: 0 }

  const safeOverscan = Math.max(0, overscan)
  const visibleStart = Math.max(0, scrollTop - safeOverscan)
  const visibleEnd = Math.max(visibleStart, scrollTop + viewportHeight + safeOverscan)

  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (rows[middle]!.end < visibleStart) low = middle + 1
    else high = middle
  }

  const start = Math.min(low, rows.length - 1)
  let end = start
  while (end < rows.length && rows[end]!.start <= visibleEnd) end += 1

  return { start, end: Math.max(start + 1, end) }
}

/** Uses a positive finite measurement, otherwise the caller-provided fallback. */
function positiveSize(value: number | undefined, fallback: number): number {
  return value != null && Number.isFinite(value) && value > 0 ? value : fallback
}
