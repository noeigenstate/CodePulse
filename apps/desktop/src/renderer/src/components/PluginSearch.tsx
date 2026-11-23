/** Filters the installed plugins by name. Escape or the clear button empties it. */
export function PluginSearch({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <div className="plugin-search">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        type="text"
        role="searchbox"
        aria-label="搜索插件"
        placeholder="搜索插件"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) {
            event.stopPropagation()
            onChange('')
          }
        }}
      />
      {value && (
        <button type="button" aria-label="清除搜索" onClick={() => onChange('')}>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M7 7l10 10M17 7 7 17" />
          </svg>
        </button>
      )}
    </div>
  )
}

/** Marks the first case-insensitive occurrence of `needle` (already lower-cased) in `text`. */
export function Highlight({ text, needle }: { text: string; needle?: string }): JSX.Element {
  const at = needle ? text.toLocaleLowerCase().indexOf(needle) : -1
  if (at < 0) return <>{text}</>
  const end = at + needle!.length
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, end)}</mark>
      {text.slice(end)}
    </>
  )
}
