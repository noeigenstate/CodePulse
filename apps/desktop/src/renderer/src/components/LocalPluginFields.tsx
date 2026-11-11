import { NumberRule } from './NumberRule.js'
import type { LifeTriple } from '../lib/yuanbaoRows.js'
import type { LocalPluginModel, NumberField } from './useLocalPlugins.js'

export function PluginNumberField({
  model,
  field,
  ...props
}: {
  model: LocalPluginModel
  field: NumberField
  label: string
  min: number
  max: number
  disabled?: boolean
  hint?: string
}): JSX.Element {
  return (
    <NumberRule
      {...props}
      value={model.draft[field]}
      onCommit={(value) => model.edit(field, value)}
    />
  )
}

export function LocalPluginSwitch({
  model,
  flag,
  label,
}: {
  model: LocalPluginModel
  flag: 'xEnabled' | 'memeEnabled' | keyof LifeTriple
  label: string
}): JSX.Element {
  const social = flag === 'xEnabled' || flag === 'memeEnabled'
  return (
    <label className="page-switch">
      <input
        type="checkbox"
        checked={social ? model.draft[flag] : model.ybConfig[flag]}
        disabled={!social && !model.yb?.hasKey}
        onChange={(event) =>
          social
            ? model.setSocialFlag(flag, event.target.checked)
            : model.setLifeFlag(flag, event.target.checked)
        }
      />
      {label}
    </label>
  )
}

export function RefreshPluginContent({ model }: { model: LocalPluginModel }): JSX.Element {
  return (
    <button
      type="button"
      className="product-button"
      disabled={model.busy || !model.snapshot || model.snapshot.collecting}
      onClick={() => void model.refreshNow()}
    >
      {model.snapshot?.collecting ? '正在检查…' : '检查新内容'}
    </button>
  )
}
