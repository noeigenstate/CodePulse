import { useState } from 'react'
import { PluginList, type PluginRow } from './PluginList.js'
import { LocalPluginDetail } from './LocalPluginDetail.js'
import { PluginDisplayRules } from './PluginDisplayRules.js'
import { useLocalPlugins } from './useLocalPlugins.js'
import './ambient-panel.css'

/** The standalone screen workbench uses the same category controller and settings. */
export function AmbientPanel({ active = true }: { active?: boolean }): JSX.Element {
  const local = useLocalPlugins({ active })
  const [selected, setSelected] = useState('local:concept')
  const rows: PluginRow[] = local.rows.map((row) => ({
    ...row,
    source: '本机',
    count: `${row.count} 张`,
  }))
  return (
    <div className="ambient-panel plugin-workbench-settings">
      <PluginList
        label="本机插件"
        rows={rows}
        logos={{}}
        selected={selected}
        busy={false}
        onOpen={(id) => {
          const row = local.rows.find((item) => item.id === id)
          if (row) {
            setSelected(id)
            local.selectCategory(row.category)
          }
        }}
        onToggle={(row) => {
          const category = local.rows.find((item) => item.id === row.id)?.category
          if (category) local.toggleCategory(category)
        }}
      />
      <div className="ambient-grid">
        <div className="ambient-card">
          <PluginDisplayRules model={local} />
        </div>
        <div className="ambient-card">
          <LocalPluginDetail model={local} />
        </div>
      </div>
    </div>
  )
}
