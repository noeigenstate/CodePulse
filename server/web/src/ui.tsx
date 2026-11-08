import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { iconText } from './format'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  primary?: boolean
  compact?: boolean
  busy?: boolean
}

/** A button whose label turns into "…" and which is disabled while its action runs. */
export function Button({ primary, compact, busy, children, className, ...rest }: ButtonProps) {
  const classes = ['btn', primary && 'primary', compact && 'compact', className]
  return (
    <button
      type="button"
      {...rest}
      className={classes.filter(Boolean).join(' ')}
      disabled={busy || rest.disabled}
    >
      {busy ? '…' : children}
    </button>
  )
}

export function Switch({
  checked,
  label,
  busy,
  onChange,
}: {
  checked: boolean
  label: string
  busy?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange(!checked)}
    />
  )
}

export const Icon = ({ name }: { name: string }) => (
  <span className="icon" aria-hidden="true">
    {iconText(name)}
  </span>
)

export type StateTone = 'ok' | 'wait' | 'bad' | ''
export const State = ({ tone, children }: { tone: StateTone; children: ReactNode }) => (
  <span className={`state ${tone}`}>{children}</span>
)

/** Error as a short word with a square mark, plus the gray reason beneath it. */
export function ErrorLine({ title = '操作失败', reason }: { title?: string; reason: string }) {
  if (!reason) return null
  return (
    <div className="notice" role="alert">
      <State tone="bad">{title}</State>
      <div className="meta">{reason}</div>
    </div>
  )
}
