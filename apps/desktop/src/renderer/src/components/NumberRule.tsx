import { useEffect, useState } from 'react'

/** A number that is only committed on blur or Enter, so typing "30" never saves "3" first. */
export function NumberRule({
  label,
  hint,
  value,
  min,
  max,
  disabled,
  onCommit,
}: {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  disabled?: boolean
  onCommit: (value: number) => void
}): JSX.Element {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const parsed = Number(text)
    const next = Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : value
    setText(String(next))
    if (next !== value) onCommit(next)
  }
  return (
    <label className="page-field" title={hint}>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
    </label>
  )
}
