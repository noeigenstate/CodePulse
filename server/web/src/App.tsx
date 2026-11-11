import type { PluginStoreMessage } from '@codepulse/shared'
import { useEffect, useState } from 'react'
import { api } from './api'
import { useAsync, useRoute, useToken, type Route } from './hooks'
import { Detail } from './pages/Detail'
import { Developer } from './pages/Developer'
import { Discover } from './pages/Discover'
import { Installed } from './pages/Installed'
import { ReviewPage } from './pages/Review'
import { devSession, storeSession } from './session'
import { EMBEDDED, type Store } from './store'
import { Button, ErrorLine, State } from './ui'

const tabs = [
  ['discover', '发现'],
  ['installed', '已安装'],
  ['developer', '开发者'],
  ['review', '审核'],
] as const

/** The desktop listens for this to refresh its pulled cards right away. */
const announceInstallChange = () => {
  const message: PluginStoreMessage = { type: 'codepulse:installs-changed' }
  if (window.parent !== window) window.parent.postMessage(message, '*')
}

function useToast() {
  const [text, setText] = useState('')
  useEffect(() => {
    if (!text) return
    const timer = setTimeout(() => setText(''), 1600)
    return () => clearTimeout(timer)
  }, [text])
  return [text, setText] as const
}

export function App() {
  const [toast, notify] = useToast()
  const storeToken = useToken(storeSession)
  const devToken = useToken(devSession)

  const plugins = useAsync(api.plugins, [])
  const installs = useAsync(() => (storeToken ? api.installs() : Promise.resolve([])), [storeToken])
  const developer = useAsync(() => (devToken ? api.devMe() : Promise.resolve(null)), [devToken])
  const admin = devToken !== '' && developer.data?.admin === true
  const reviews = useAsync(() => (admin ? api.reviews() : Promise.resolve([])), [admin])

  // Tabs a viewer cannot use (review for non-admins, installed when embedded) fall back to the
  // catalog, so a stale or hand-typed hash never lands on a hidden page.
  const visibleTabs = tabs.filter(([id]) =>
    id === 'review' ? admin : id === 'installed' ? !EMBEDDED : true,
  )
  const route = useRoute()
  const current: Route =
    route.page === 'plugin' || visibleTabs.some(([id]) => id === route.page)
      ? route
      : { page: 'discover' }

  const store: Store | undefined = plugins.data &&
    installs.data && {
      plugins: plugins.data,
      installs: installs.data,
      signedIn: storeToken !== '',
      async change(action, message) {
        await action()
        await installs.reload()
        announceInstallChange()
        notify(message)
      },
    }
  const counts: Record<string, number | undefined> = {
    installed: storeToken ? installs.data?.length : undefined,
    review: admin ? reviews.data?.length : undefined,
  }

  // Embedded, the desktop already shows a tab row above, so pages switch with a segmented control
  // that sits on the catalog's filter row instead of a second row of tabs.
  const tabList = (
    <div className={EMBEDDED ? 'seg' : 'tabs'} role="tablist" aria-label="插件页面">
      {visibleTabs.map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={current.page === id}
          onClick={() => (location.hash = `#/${id}`)}
        >
          {label}
          {counts[id] !== undefined && <span className="count">{counts[id]}</span>}
        </button>
      ))}
    </div>
  )
  const tabsInCatalog = EMBEDDED && current.page === 'discover'

  const view = () => {
    if (current.page === 'developer')
      return <Developer developer={devToken ? developer.data : null} notify={notify} />
    if (current.page === 'review')
      return <ReviewPage reviews={reviews.data ?? []} reload={reviews.reload} notify={notify} />
    if (!store) {
      const error = plugins.error || installs.error
      const retry = () => {
        plugins.reload()
        installs.reload()
      }
      return error && <Unreachable error={error} retry={retry} />
    }
    if (current.page === 'plugin') return <Detail key={current.id} id={current.id} store={store} />
    if (current.page === 'installed') return <Installed store={store} />
    return <Discover store={store} lead={tabsInCatalog ? tabList : undefined} />
  }

  return (
    <main className="store">
      {current.page !== 'plugin' && (
        <>
          {!EMBEDDED && (
            <header className="page-header">
              <div>
                <h1>插件</h1>
                <p>
                  为墨水屏添加桌边内容
                  {plugins.error ? (
                    <State tone="bad">未连接平台</State>
                  ) : (
                    plugins.data && <State tone="ok">已连接平台</State>
                  )}
                </p>
              </div>
            </header>
          )}
          {!tabsInCatalog && (
            <div className={EMBEDDED ? 'toolbar embedded' : 'toolbar'}>{tabList}</div>
          )}
        </>
      )}
      {view()}
      <div className={toast ? 'toast on' : 'toast'} role="status">
        {toast}
      </div>
    </main>
  )
}

function Unreachable({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="panel">
      <ErrorLine title="无法连接插件平台" reason={error} />
      <div className="form-foot">
        <Button onClick={retry}>重试</Button>
      </div>
    </div>
  )
}
