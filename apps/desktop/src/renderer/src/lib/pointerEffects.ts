/** Maximum card tilt in degrees; small enough to keep text crisp and readable. */
const MAX_TILT_DEG = 3.5

/**
 * Drives the cursor spotlight (`.fx-spot`) and 3D tilt (`.fx-tilt`) effects.
 *
 * One delegated `pointermove` listener, batched to one update per frame,
 * writes CSS custom properties on the hovered element and every `.fx-spot`
 * ancestor: `--mx`/`--my` (pointer position in px) and, for `.fx-tilt`,
 * `--rx`/`--ry` (tilt in degrees). `data-pointer` marks elements under the
 * pointer so CSS can fade the effect in and out. Styling lives in index.css.
 *
 * Does nothing when the user asked the OS to reduce motion.
 *
 * @param root Document to listen on.
 * @returns Cleanup that removes the listeners and clears any active effect.
 */
export function installPointerEffects(root: Document = document): () => void {
  const view = root.defaultView
  if (!view || view.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => undefined

  let frame = 0
  let pending: { x: number; y: number; target: EventTarget | null } | undefined
  let active: HTMLElement[] = []

  const clear = (elements: HTMLElement[]): void => {
    for (const el of elements) {
      delete el.dataset['pointer']
      el.style.removeProperty('--rx')
      el.style.removeProperty('--ry')
    }
  }

  const apply = (): void => {
    frame = 0
    const event = pending
    pending = undefined
    if (!event) return

    const next: HTMLElement[] = []
    let node =
      event.target instanceof Element ? event.target.closest<HTMLElement>('.fx-spot') : null
    while (node) {
      next.push(node)
      node = node.parentElement?.closest<HTMLElement>('.fx-spot') ?? null
    }
    clear(active.filter((el) => !next.includes(el)))
    active = next

    for (const el of next) {
      const rect = el.getBoundingClientRect()
      const x = event.x - rect.left
      const y = event.y - rect.top
      el.dataset['pointer'] = ''
      el.style.setProperty('--mx', `${x}px`)
      el.style.setProperty('--my', `${y}px`)
      if (el.classList.contains('fx-tilt') && rect.width > 0 && rect.height > 0) {
        el.style.setProperty(
          '--rx',
          `${((0.5 - y / rect.height) * 2 * MAX_TILT_DEG).toFixed(2)}deg`,
        )
        el.style.setProperty('--ry', `${((x / rect.width - 0.5) * 2 * MAX_TILT_DEG).toFixed(2)}deg`)
      }
    }
  }

  const onMove = (event: PointerEvent): void => {
    pending = { x: event.clientX, y: event.clientY, target: event.target }
    if (!frame) frame = view.requestAnimationFrame(apply)
  }
  const onLeave = (): void => {
    pending = undefined
    clear(active)
    active = []
  }

  root.addEventListener('pointermove', onMove, { passive: true })
  root.documentElement.addEventListener('pointerleave', onLeave)
  view.addEventListener('blur', onLeave)
  return () => {
    if (frame) view.cancelAnimationFrame(frame)
    root.removeEventListener('pointermove', onMove)
    root.documentElement.removeEventListener('pointerleave', onLeave)
    view.removeEventListener('blur', onLeave)
    onLeave()
  }
}
