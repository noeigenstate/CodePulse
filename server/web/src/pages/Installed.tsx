import type { PluginListing } from '@codepulse/shared'
import { relativeTime } from '../format'
import { useAction } from '../hooks'
import type { InstallRow } from '../api'
import { api } from '../api'
import { SIGN_IN_HINT, type Store } from '../store'
import { Button, ErrorLine, Icon, State, Switch } from '../ui'

function Row({
  install,
  plugin,
  store,
}: {
  install: InstallRow
  /** Undefined when the plugin was withdrawn from the catalog after it was installed. */
  plugin?: PluginListing
  store: Store
}) {
  const { busy, error, run } = useAction()
  const { enabled, pluginId, status } = install
  const name = plugin?.name ?? pluginId
  return (
    <div className="list-row" role="row">
      <div className="who c-who">
        <Icon name={name} logoUrl={plugin?.logoUrl} />
        <div>
          <div>{name}</div>
          {plugin && <div className="meta">{`v${plugin.version}`}</div>}
        </div>
      </div>
      <div className="c-state">
        {!enabled ? (
          <State tone="">已停用</State>
        ) : status.error ? (
          <>
            <State tone="bad">生成失败</State>
            <div className="meta">{status.error}</div>
          </>
        ) : (
          <State tone="ok">正常</State>
        )}
      </div>
      <span className="meta c-time">{relativeTime(status.generatedAt)}</span>
      <div className="actions c-act">
        <a className="btn compact" href={`#/plugin/${encodeURIComponent(pluginId)}`}>
          设置
        </a>
        <Button
          compact
          busy={busy}
          onClick={() =>
            run(() =>
              store.change(() => api.deleteInstall(pluginId), '已卸载，墨水屏下次轮播不再出现'),
            )
          }
        >
          卸载
        </Button>
        <Switch
          checked={enabled}
          label={`启用 ${name}`}
          busy={busy}
          onChange={(next) =>
            run(() =>
              store.change(
                () => api.putInstall(pluginId, { enabled: next }),
                next ? '已启用' : '已停用，不再生成卡片',
              ),
            )
          }
        />
      </div>
      {error && (
        <div className="c-note">
          <ErrorLine reason={error} />
        </div>
      )}
    </div>
  )
}

export function Installed({ store }: { store: Store }) {
  if (!store.signedIn) return <p className="hint">{SIGN_IN_HINT}</p>
  return (
    <section>
      <p className="hint">关闭后不再生成卡片。桌面端每 15 分钟拉取一次，修改立即生效。</p>
      <div className="list installed" role="table" aria-label="已安装插件">
        <div className="list-head meta" role="row">
          <span role="columnheader" className="c-who">
            插件
          </span>
          <span role="columnheader" className="c-state">
            状态
          </span>
          <span role="columnheader" className="c-time">
            最近生成
          </span>
          <span role="columnheader" className="c-act" style={{ textAlign: 'right' }}>
            操作
          </span>
        </div>
        {store.installs.length === 0 && (
          <div className="list-row">
            <span className="meta">还没有安装插件。</span>
          </div>
        )}
        {store.installs.map((install) => (
          <Row
            key={install.pluginId}
            install={install}
            plugin={store.plugins.find((p) => p.id === install.pluginId)}
            store={store}
          />
        ))}
      </div>
    </section>
  )
}
