import type { PluginKind } from '@codepulse/shared'
import { useState, type ReactNode } from 'react'
import { countText, kindName } from '../format'
import type { Store } from '../store'
import { Icon, State } from '../ui'

const kinds: (PluginKind | 'all')[] = ['all', 'builtin', 'pack', 'webhook']

/** `lead` is the page switcher, which the embedded page puts on the filter row. */
export function Discover({ store, lead }: { store: Store; lead?: ReactNode }) {
  const [kind, setKind] = useState<PluginKind | 'all'>('all')
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = store.plugins.filter(
    (p) =>
      (kind === 'all' || p.kind === kind) &&
      (!q || [p.name, p.summary, p.developer].some((text) => text.toLowerCase().includes(q))),
  )
  const installed = new Set(store.installs.map((i) => i.pluginId))

  return (
    <section>
      <div className="filters">
        {lead}
        <div className="chips" role="group" aria-label="按类型筛选">
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              className="chip"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
            >
              {k === 'all' ? '全部' : kindName[k]}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <input
          className="search"
          type="search"
          placeholder="搜索插件"
          aria-label="搜索插件"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {shown.length === 0 ? (
        <p className="hint">没有找到插件。</p>
      ) : (
        <div className="grid">
          {shown.map((p) => (
            <a key={p.id} className="card" href={`#/plugin/${encodeURIComponent(p.id)}`}>
              <div className="card-head">
                <Icon name={p.name} logoUrl={p.logoUrl} />
                <div>
                  <h3>{p.name}</h3>
                  <div className="meta">{p.developer}</div>
                </div>
              </div>
              <p className="desc">{p.summary}</p>
              <div className="card-foot">
                <span className="meta">{`${kindName[p.kind]} · v${p.version} · ${countText(p.installs)} 次安装`}</span>
                {installed.has(p.id) && <State tone="ok">已安装</State>}
              </div>
            </a>
          ))}
        </div>
      )}
    </section>
  )
}
