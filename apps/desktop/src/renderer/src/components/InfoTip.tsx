import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

/**
 * The one way to carry an explanation: a focusable ⓘ button whose text shows in a small bubble on
 * hover and on keyboard focus, is tied to the button with aria-describedby, and closes on Escape.
 * The bubble stays inside the window (it is placed from the button's position on every open).
 */
export function InfoTip({ text, label = '说明' }: { text: string; label?: string }): JSX.Element {
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const bubble = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<CSSProperties>({})
  useLayoutEffect(() => {
    if (!open || !button.current || !bubble.current) return
    const anchor = button.current.getBoundingClientRect()
    const width = bubble.current.offsetWidth
    const height = bubble.current.offsetHeight
    const left = Math.max(
      8,
      Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - 8),
    )
    const above = anchor.top - height - 6
    setPlace({
      left,
      top: above >= 8 ? above : Math.min(anchor.bottom + 6, window.innerHeight - height - 8),
    })
  }, [open, text])
  return (
    <span className="info-tip-wrap">
      <button
        ref={button}
        type="button"
        className="info-tip"
        aria-label={label}
        aria-describedby={id}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={(event) => {
          // Only keyboard focus opens it; a mouse click should not leave a bubble stuck open.
          if (event.currentTarget.matches(':focus-visible')) setOpen(true)
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.stopPropagation()
            setOpen(false)
          }
        }}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <circle cx="8" cy="8" r="6.5" />
          <path d="M8 7.2v3.6" />
          <circle cx="8" cy="4.9" r=".4" fill="currentColor" />
        </svg>
      </button>
      <span
        ref={bubble}
        id={id}
        role="tooltip"
        className={`info-tip-bubble${open ? ' is-open' : ''}`}
        style={open ? place : undefined}
      >
        {text}
      </span>
    </span>
  )
}
