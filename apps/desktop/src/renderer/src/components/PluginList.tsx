import { useState } from 'react'
import { PluginStatus } from './PluginStatus.js'
import type { PluginRow } from '../lib/pluginPresentation.js'

export type { PluginRow } from '../lib/pluginPresentation.js'

export function PluginLogo({
  name,
  glyph,
  sources,
  large = false,
}: {
  name: string
  glyph?: string
  sources: (string | null | undefined)[]
  large?: boolean
}): JSX.Element {
  const [failed, setFailed] = useState<string[]>([])
  const src = sources.find((source) => source && !failed.includes(source))
  return (
    <span className={`plugin-logo${large ? ' is-large' : ''}`} aria-hidden="true">
      {src ? (
        <img alt="" src={src} onError={() => setFailed((old) => [...old, src])} />
      ) : (
        (glyph ?? Array.from(name)[0])
      )}
    </span>
  )
}

export function PluginSwitch({
  row,
  busy,
  onToggle,
}: {
  row: PluginRow
  busy: boolean
  onToggle: (row: PluginRow) => void
}): JSX.Element {
  return (
    <button
      type="button"
      className="plugin-switch"
      role="switch"
      aria-checked={row.enabled === true}
      aria-label={`启用 ${row.name}`}
      disabled={busy || row.disabled || row.enabled === null}
      onClick={() => onToggle(row)}
    />
  )
}

export function PluginList({
  label,
  rows,
  logos,
  selected,
  busy,
  onOpen,
  onToggle,
}: {
  label: string
  rows: PluginRow[]
  logos: Record<string, string>
  selected: string | undefined
  busy: boolean
  onOpen: (id: string) => void
  onToggle: (row: PluginRow) => void
}): JSX.Element {
  return (
    <div className="plugin-list" role="table" aria-label={label}>
      <div className="plugin-list-head" role="row">
        {['插件', '状态', '卡片', '操作'].map((title) => (
          <span role="columnheader" key={title}>
            {title}
          </span>
        ))}
      </div>
      {rows.map((row) => (
        <div
          className="plugin-row"
          role="row"
          key={row.id}
          data-plugin-id={row.id}
          data-selected={selected === row.id}
        >
          <div className="plugin-who" role="cell">
            <PluginLogo name={row.name} glyph={row.glyph} sources={[logos[row.id], row.logo]} />
            <div>
              <strong>{row.name}</strong>
              <p className="page-muted">{row.source}</p>
            </div>
          </div>
          <div className="plugin-status-cell" role="cell">
            <PluginStatus state={row.state} reason={row.reason} />
          </div>
          <span className="plugin-count page-muted" role="cell">
            {row.count}
          </span>
          <div className="plugin-actions" role="cell">
            <button
              type="button"
              className="product-button is-compact"
              onClick={() => onOpen(row.id)}
            >
              设置
            </button>
            {row.enabled === null ? (
              <span className="plugin-switch-space" />
            ) : (
              <PluginSwitch row={row} busy={busy} onToggle={onToggle} />
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
