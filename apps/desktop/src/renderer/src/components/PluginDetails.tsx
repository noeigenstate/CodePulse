import { useEffect, useRef, type ReactNode } from 'react'

export function PluginDetails({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}): JSX.Element {
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    panel.current?.focus()
    const keydown = (event: KeyboardEvent) => {
      // Escape closes the innermost layer first: an open tip or preview menu handles it before us.
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
      if (event.key !== 'Tab') return
      const controls = [
        ...(panel.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
        ) ?? []),
      ].filter((element) => element.getClientRects().length > 0)
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === panel.current)
      ) {
        event.preventDefault()
        last?.focus()
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || document.activeElement === panel.current)
      ) {
        event.preventDefault()
        first?.focus()
      }
    }
    // Bubble phase on window, so nested handlers (React onKeyDown, document listeners) run first.
    window.addEventListener('keydown', keydown)
    return () => {
      window.removeEventListener('keydown', keydown)
      if (previous?.isConnected) previous.focus()
    }
  }, [open, onClose])
  return (
    <div className="plugin-details-layer" hidden={!open}>
      <button
        type="button"
        className="plugin-details-backdrop"
        tabIndex={-1}
        onClick={onClose}
        aria-label="关闭详情"
      />
      <aside
        ref={panel}
        className="plugin-details"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="plugin-details-close">
          <button type="button" className="product-button is-compact" onClick={onClose}>
            关闭
          </button>
        </div>
        {children}
      </aside>
    </div>
  )
}
