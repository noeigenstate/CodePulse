import { useState, type CSSProperties } from 'react'
import { PluginStatus } from './PluginStatus.js'
import { PLATFORM_PLUGIN_HUE, PLUGIN_ART } from './PluginArt.js'
import { Highlight } from './PluginSearch.js'
import type { PluginRow } from '../lib/pluginPresentation.js'

export type { PluginRow } from '../lib/pluginPresentation.js'

/**
 * A plugin's picture: the user's or the platform's image when one loads, otherwise the built-in
 * illustration for that plugin, otherwise its initials, both on a tint of the plugin's hue.
 */
export function PluginLogo({
  id,
  name,
  glyph,
  sources,
  large = false,
}: {
  id: string
  name: string
  glyph?: string
  sources: (string | null | undefined)[]
  large?: boolean
}): JSX.Element {
  const [failed, setFailed] = useState<string[]>([])
  const src = sources.find((source) => source && !failed.includes(source))
  const art = PLUGIN_ART[id]
  const size = large ? ' is-large' : ''
  if (src)
    return (
      <span className={`plugin-logo${size}`} aria-hidden="true">
        <img alt="" src={src} onError={() => setFailed((old) => [...old, src])} />
      </span>
    )
  return (
    <span
      className={`plugin-logo is-tinted${size}`}
      style={{ '--plugin-hue': art?.hue ?? PLATFORM_PLUGIN_HUE } as CSSProperties}
      aria-hidden="true"
    >
      {art ? (
        <svg viewBox="0 0 48 48" focusable="false">
          {art.art}
        </svg>
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
  showSource = true,
  highlight,
  onOpen,
  onToggle,
}: {
  label: string
  rows: PluginRow[]
  logos: Record<string, string>
  selected: string | undefined
  busy: boolean
  /** False when the group heading already says where these plugins come from. */
  showSource?: boolean
  /** Lower-cased search text to mark in each name. */
  highlight?: string
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
            <PluginLogo
              id={row.id}
              name={row.name}
              glyph={row.glyph}
              sources={[logos[row.id], row.logo]}
            />
            <div>
              <strong>
                <Highlight text={row.name} needle={highlight} />
              </strong>
              {showSource && <p className="page-muted">{row.source}</p>}
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
