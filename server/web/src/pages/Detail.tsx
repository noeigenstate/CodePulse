import {
  normalizePluginSettings,
  type PluginListing,
  type PluginSetting,
  type PluginSettingValues,
} from '@codepulse/shared'
import { useState } from 'react'
import { api } from '../api'
import { EpdPreview } from '../EpdPreview'
import { countText, kindName } from '../format'
import { useAction, useAsync } from '../hooks'
import { SIGN_IN_HINT, type Store } from '../store'
import { Button, ErrorLine, Icon, Switch } from '../ui'

type Values = PluginSettingValues

function SettingRow({
  setting,
  value,
  onChange,
}: {
  setting: PluginSetting
  value: Values[string]
  onChange: (value: Values[string]) => void
}) {
  const id = `setting-${setting.key}`
  if (setting.type === 'boolean') {
    return (
      <div>
        <span className="label">{setting.label}</span>
        <Switch checked={value === true} label={setting.label} onChange={onChange} />
      </div>
    )
  }
  return (
    <div>
      <label htmlFor={id}>{setting.label}</label>
      {setting.type === 'select' ? (
        <select
          id={id}
          className="control"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        >
          {setting.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : setting.type === 'number' ? (
        <input
          id={id}
          className="control"
          type="number"
          min={setting.min}
          max={setting.max}
          value={Number.isNaN(value) ? '' : String(value)}
          onChange={(e) => onChange(e.target.valueAsNumber)}
        />
      ) : (
        <input
          id={id}
          className="control"
          maxLength={setting.maxLength}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  )
}

function Header({
  plugin,
  store,
  values,
}: {
  plugin: PluginListing
  store: Store
  values: Values
}) {
  const { busy, error, run } = useAction()
  const installed = store.installs.some((i) => i.pluginId === plugin.id)
  const toggle = () =>
    run(() =>
      installed
        ? store.change(() => api.deleteInstall(plugin.id), '已卸载')
        : store.change(
            () => api.putInstall(plugin.id, { enabled: true, settings: values }),
            '已安装，几分钟内出现在桌边内容轮播里',
          ),
    )
  return (
    <>
      <div className="detail-head">
        <Icon name={plugin.name} />
        <div>
          <h1>{plugin.name}</h1>
          <p className="meta">
            {`${plugin.developer} · ${kindName[plugin.kind]} · v${plugin.version} · ${countText(plugin.installs)} 次安装`}
          </p>
        </div>
        {store.signedIn ? (
          <Button primary={!installed} busy={busy} onClick={toggle}>
            {installed ? '卸载' : '安装'}
          </Button>
        ) : (
          <span className="meta">{SIGN_IN_HINT}</span>
        )}
      </div>
      <ErrorLine reason={error} />
    </>
  )
}

export function Detail({ id, store }: { id: string; store: Store }) {
  const plugin = store.plugins.find((p) => p.id === id)
  const install = store.installs.find((i) => i.pluginId === id)
  const preview = useAsync(() => api.preview(id), [id])
  const save = useAction()
  const [values, setValues] = useState<Values>(() =>
    normalizePluginSettings(plugin?.settings ?? [], install?.settings),
  )

  const back = (
    <a className="link" href="#/discover">
      ← 返回插件
    </a>
  )
  if (!plugin) {
    return (
      <>
        {back}
        <p className="hint">没有找到这个插件。</p>
      </>
    )
  }

  return (
    <section>
      {back}
      <Header plugin={plugin} store={store} values={values} />
      <div className="detail">
        <div className="stack">
          <div className="panel">
            <div className="panel-head">
              <h2>说明</h2>
            </div>
            <p className="body">{plugin.description}</p>
          </div>
          <div className="panel">
            <div className="panel-head">
              <h2>设置</h2>
            </div>
            {plugin.settings.length === 0 ? (
              <p className="meta">这个插件没有可调整的设置。</p>
            ) : (
              <div className="rows">
                {plugin.settings.map((s) => (
                  <SettingRow
                    key={s.key}
                    setting={s}
                    value={values[s.key]}
                    onChange={(value) => setValues({ ...values, [s.key]: value })}
                  />
                ))}
              </div>
            )}
            {install && (
              <>
                <ErrorLine reason={save.error} />
                <div className="form-foot">
                  <Button
                    busy={save.busy}
                    onClick={() =>
                      save.run(() =>
                        store.change(
                          () => api.putInstall(plugin.id, { settings: values }),
                          '设置已保存，下次生成时生效',
                        ),
                      )
                    }
                  >
                    保存设置
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="panel preview">
          <div className="panel-head">
            <h2>墨水屏效果</h2>
          </div>
          <EpdPreview
            cards={preview.data?.cards}
            error={preview.error || preview.data?.error || ''}
            label={plugin.name}
          />
        </div>
      </div>
    </section>
  )
}
