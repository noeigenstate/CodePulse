import { useEffect } from 'react'

const FLAG = 'tipsDismissed'
const SCOPE = '[data-tip-scope]'

/** Whether any sidebar name tooltip is on screen right now. */
function tipIsShowing(): boolean {
  return Array.from(document.querySelectorAll('.product-tip')).some(
    (tip) => getComputedStyle(tip).visibility === 'visible',
  )
}

/**
 * Lets Escape hide the sidebar's name tooltips (WCAG 1.4.13, dismissible).
 *
 * Escape is only taken while a tooltip is showing. The tooltips stay hidden (the stylesheet reads
 * the flag on the root element) until the pointer leaves the control group it was in or focus
 * moves to another control.
 */
export function useTipDismiss(): void {
  useEffect(() => {
    const root = document.documentElement
    const reset = () => delete root.dataset[FLAG]
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !tipIsShowing()) return
      event.preventDefault()
      root.dataset[FLAG] = ''
    }
    const onPointerOut = ({ target, relatedTarget }: PointerEvent) => {
      const left = target instanceof Element ? target.closest(SCOPE) : null
      const entered = relatedTarget instanceof Element ? relatedTarget.closest(SCOPE) : null
      if (left && left !== entered) reset()
    }
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('focusin', reset)
    document.addEventListener('pointerout', onPointerOut)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('focusin', reset)
      document.removeEventListener('pointerout', onPointerOut)
      reset()
    }
  }, [])
}
