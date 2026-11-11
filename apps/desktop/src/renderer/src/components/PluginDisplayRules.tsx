import { PluginNumberField } from './LocalPluginFields.js'
import { pluginInkPlan } from '../lib/localPlugins.js'
import type { LocalPluginModel } from './useLocalPlugins.js'
import type { ProductNavigation } from './ProductFrame.js'

export function PluginDisplayRules({
  model,
  product,
}: {
  model: LocalPluginModel
  product?: ProductNavigation
}): JSX.Element {
  const { snapshot, draft, edit, saveFailed, savedFlash } = model
  return (
    <div className="ambient-panel plugin-rules">
      <details className="ambient-details ambient-pacing" open>
        <summary>展示规则</summary>
        <fieldset className="ambient-fieldset" disabled={!snapshot}>
          {product && (
            <label className="page-switch">
              <input
                type="checkbox"
                disabled={!product.ready}
                checked={draft.enabled}
                onChange={(e) => {
                  const plan = product.shell.inkPlan
                  void product.setInkPlan(pluginInkPlan(plan, 'ambient', e.target.checked))
                }}
              />
              自动展示插件卡片
            </label>
          )}
          <label className="page-switch">
            <input
              type="checkbox"
              checked={draft.idleOnly}
              onChange={(e) => edit('idleOnly', e.target.checked)}
            />
            仅在 Agent 空闲时展示
          </label>
          <div className="ambient-fields">
            <PluginNumberField
              model={model}
              field="pollMinutes"
              label="检查间隔（分钟）"
              min={15}
              max={1440}
            />
            <PluginNumberField
              model={model}
              field="gapMinutes"
              label="展示间隔（分钟）"
              min={30}
              max={1440}
            />
            <PluginNumberField
              model={model}
              field="dailyLimit"
              label="每天最多展示"
              min={1}
              max={24}
            />
            <PluginNumberField
              model={model}
              field="quietStart"
              label="安静开始（小时）"
              min={0}
              max={23}
            />
            <PluginNumberField
              model={model}
              field="quietEnd"
              label="安静结束（小时）"
              min={0}
              max={23}
            />
          </div>
        </fieldset>
      </details>
      {saveFailed && <p role="alert">保存未完成，请重试。</p>}
      <span className="page-muted" role="status">
        {savedFlash ? '已保存' : ''}
      </span>
    </div>
  )
}
