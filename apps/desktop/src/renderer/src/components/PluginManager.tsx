import { useCallback, useEffect, useState } from 'react'
import { productDestination } from '@codepulse/shared'
import { PluginDetails } from './PluginDetails.js'
import { PluginList, PluginLogo, PluginSwitch, type PluginRow } from './PluginList.js'
import { cloudPluginRows } from '../lib/pluginPresentation.js'
import { pluginInkPlan } from '../lib/localPlugins.js'
import { useLocalPlugins } from './useLocalPlugins.js'
import { useCloudPlugins } from './useCloudPlugins.js'
import { LocalPluginDetail } from './LocalPluginDetail.js'
import { PluginDisplayRules } from './PluginDisplayRules.js'
import { CloudPluginPreview } from './CloudPluginPreview.js'
import { PluginStatus } from './PluginStatus.js'
import { AssistantPanel } from './AssistantPanel.js'
import { PageHeader } from './PageHeader.js'
import { PluginStore } from './PluginStore.js'
import { PluginSearch } from './PluginSearch.js'
import type { ProductNavigation } from './ProductFrame.js'
import type { Locale } from '../lib/i18n.js'

export function PluginManager({
  active,
  product,
  locale,
}: {
  active: boolean
  product: ProductNavigation
  locale: Locale
}): JSX.Element {
  const [tab, setTab] = useState<'installed' | 'market'>('installed')
  const [route, setRoute] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const [rulesOpen, setRulesOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [todoCount, setTodoCount] = useState<number>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const { cloud, logos, error: cloudError, loading, refresh } = useCloudPlugins(active)
  const local = useLocalPlugins({
    active:
      active &&
      tab === 'installed' &&
      Boolean(selected?.startsWith('local:')) &&
      selected !== 'local:todo',
  })
  useEffect(() => {
    if (product.view !== 'assistant' && product.view !== 'ambient') return
    setTab('installed')
    setRulesOpen(false)
    setSelected(productDestination(product.view).pluginId)
    // Settle on the canonical page so the next legacy entry changes the view and runs this again.
    void product.navigate('plugins')
  }, [product.view])
  const closeDetails = useCallback(() => {
    setSelected(undefined)
    setRulesOpen(false)
  }, [])
  const run = async (
    action: () => Promise<{ ok: true } | { error: string } | { cancelled: true } | void>,
  ) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await action()
      if (result && 'cancelled' in result) return
      if (result && 'error' in result) setError(result.error)
      else await refresh()
    } catch {
      setError('操作未完成，请重试。')
    } finally {
      setBusy(false)
    }
  }
  const rows: PluginRow[] = local.rows.map((row) => ({
    ...row,
    source: '本机 · 随应用自带',
    count: `${row.count} 张`,
  }))
  const todoEnabled =
    product.shell.inkPlan.mode === 'cycle' && product.shell.inkPlan.items.includes('todos')
  rows.push({
    id: 'local:todo',
    name: '待办与助手',
    source: '本机 · 随应用自带',
    enabled: todoEnabled,
    disabled: !product.ready,
    state: todoEnabled ? '正常' : '已关闭',
    count: todoCount === undefined ? '—' : `${todoCount} 项待办`,
    reason: '开关控制墨水屏节目单展示',
  })
  const platformRows = cloudPluginRows(
    cloud?.plugins ?? [],
    cloud?.platformOrigin ?? '',
    local.snapshot?.cards ?? [],
  )
  const current = [...rows, ...platformRows].find((row) => row.id === selected)
  const needle = query.trim().toLocaleLowerCase()
  const matches = (row: PluginRow) => !needle || row.name.toLocaleLowerCase().includes(needle)
  const localHits = rows.filter(matches)
  const platformHits = platformRows.filter(matches)
  const openDetails = (id: string) => {
    setError('')
    setRulesOpen(false)
    setSelected(id)
    const category = local.rows.find((row) => row.id === id)?.category
    if (category) local.selectCategory(category)
  }
  const toggle = (row: PluginRow) => {
    if (row.disabled || row.enabled === null) return
    if (row.id === 'local:todo') {
      const plan = product.shell.inkPlan
      void product.setInkPlan(pluginInkPlan(plan, 'todos', !todoEnabled))
      return
    }
    const category = local.rows.find((item) => item.id === row.id)?.category
    if (category) local.toggleCategory(category)
    else void run(() => window.codepulse.setCloudPluginEnabled(row.id, !row.enabled))
  }
  const openMarket = (pluginId?: string) => {
    closeDetails()
    setRoute(pluginId ? `#/plugin/${pluginId}` : '#/discover')
    setTab('market')
  }
  return (
    <section className="product-page plugin-manager">
      <div className="plugin-manager-header">
        <PageHeader title="插件" />
        <div className="plugin-manager-bar">
          <div className="product-page-tabs" role="tablist" aria-label="插件页面">
            <button
              type="button"
              role="tab"
              id="plugins-installed-tab"
              aria-controls="plugins-installed"
              aria-selected={tab === 'installed'}
              onClick={() => {
                closeDetails()
                setTab('installed')
                void refresh()
              }}
            >
              已安装
            </button>
            <button
              type="button"
              role="tab"
              id="plugins-market-tab"
              aria-controls="plugins-market"
              aria-selected={tab === 'market'}
              onClick={() => openMarket()}
            >
              插件市场
            </button>
          </div>
          {tab === 'installed' && (
            <div className="plugin-manager-tools">
              <PluginSearch value={query} onChange={setQuery} />
              <button
                type="button"
                className="product-button"
                onClick={() => {
                  setSelected(undefined)
                  setRulesOpen(true)
                }}
              >
                展示规则
              </button>
            </div>
          )}
        </div>
      </div>
      {(error || cloudError) && !current && !rulesOpen && (
        <p className="plugin-manager-error" role="alert">
          {error || cloudError}
        </p>
      )}
      <div
        id="plugins-installed"
        role="tabpanel"
        aria-labelledby="plugins-installed-tab"
        className="product-scroll plugin-installed"
        hidden={tab !== 'installed'}
      >
        {!local.snapshot && !needle && (
          <p className="plugin-empty" role="status">
            {local.loadError || '正在读取本机插件…'}
          </p>
        )}
        {localHits.length > 0 && (
          <>
            <div className="plugin-group-title">
              <h2>本机插件</h2>
              <p className="page-muted">随应用自带，在这台电脑上运行</p>
            </div>
            <PluginList
              label="本机插件"
              rows={localHits}
              logos={logos}
              selected={selected}
              busy={busy}
              showSource={false}
              highlight={needle}
              onOpen={openDetails}
              onToggle={toggle}
            />
          </>
        )}
        {/* Only plugins someone installed earn a group; the market tab is the way to find more. */}
        {platformHits.length > 0 && (
          <>
            <div className="plugin-group-title">
              <h2>平台插件</h2>
              <p className="page-muted">从插件市场安装，云端生成卡片</p>
            </div>
            {cloud?.state === 'offline' && (
              <p className="plugin-empty" role="status">
                插件平台暂未连接。
                <button
                  type="button"
                  className="page-link"
                  disabled={loading}
                  onClick={() => void refresh()}
                >
                  重试
                </button>
              </p>
            )}
            <PluginList
              label="平台插件"
              rows={platformHits}
              logos={logos}
              selected={selected}
              busy={busy || cloud?.state !== 'ok'}
              highlight={needle}
              onOpen={openDetails}
              onToggle={toggle}
            />
          </>
        )}
        {needle && !localHits.length && !platformHits.length && (
          <p className="plugin-empty" role="status">
            没有找到与「{query.trim()}」相关的插件。
          </p>
        )}
      </div>
      {tab === 'market' && active && (
        <div
          id="plugins-market"
          role="tabpanel"
          aria-labelledby="plugins-market-tab"
          className="product-page"
        >
          <PluginStore route={route} />
        </div>
      )}
      <PluginDetails
        open={active && tab === 'installed' && (Boolean(current) || rulesOpen)}
        title={rulesOpen ? '展示规则' : `${current?.name ?? ''}详情`}
        onClose={closeDetails}
      >
        {rulesOpen && (
          <>
            <h2>展示规则</h2>
            <PluginDisplayRules model={local} product={product} />
          </>
        )}
        {current && (
          <>
            <header className="plugin-details-header">
              <PluginLogo
                id={current.id}
                name={current.name}
                glyph={current.glyph}
                sources={[logos[current.id], current.logo]}
                large
              />
              <div>
                <h2>{current.name}</h2>
                <p className="page-muted">{current.source}</p>
                <PluginStatus state={current.state} reason={current.reason} />
              </div>
              {current.enabled !== null && (
                <PluginSwitch
                  row={current}
                  busy={busy || Boolean(current.install && cloud?.state !== 'ok')}
                  onToggle={toggle}
                />
              )}
            </header>
            <section className="plugin-details-section">
              <h3>图标</h3>
              <div className="plugin-actions">
                <button
                  type="button"
                  className="product-button is-compact"
                  disabled={busy}
                  onClick={() => void run(() => window.codepulse.pickPluginLogo(current.id))}
                >
                  更换图标
                </button>
                <button
                  type="button"
                  className="product-button is-compact"
                  disabled={busy || !logos[current.id]}
                  onClick={() => void run(() => window.codepulse.resetPluginLogo(current.id))}
                >
                  恢复默认
                </button>
              </div>
              <p className="page-muted">
                PNG、JPEG 或 WebP，正方形，64–1024 像素，不超过 200 KB。只保存在这台电脑。
              </p>
            </section>
            {error && (
              <p role="alert" className="plugin-manager-error">
                {error}
              </p>
            )}
            {current.install ? (
              <section className="plugin-details-section">
                <h3>设置</h3>
                <p>{current.install.plugin?.description ?? '该插件已从市场下架。'}</p>
                <p className="page-muted">
                  版本 {current.install.plugin?.version ?? '未知'} · 最近生成{' '}
                  {current.install.status.generatedAt
                    ? new Date(current.install.status.generatedAt).toLocaleString('zh-CN')
                    : '尚未生成'}
                </p>
                <div className="plugin-actions">
                  <button
                    type="button"
                    className="product-button"
                    onClick={() => openMarket(current.id)}
                  >
                    在插件市场中设置
                  </button>
                  <button
                    type="button"
                    className="product-button"
                    disabled={busy || cloud?.state !== 'ok'}
                    onClick={() =>
                      void run(async () => {
                        const result = await window.codepulse.uninstallCloudPlugin(current.id)
                        if ('error' in result) return result
                        closeDetails()
                      })
                    }
                  >
                    卸载
                  </button>
                </div>
              </section>
            ) : (
              current.id !== 'local:todo' && <LocalPluginDetail model={local} />
            )}
          </>
        )}
        {current?.install && (
          <CloudPluginPreview
            pluginId={current.id}
            snapshot={local.snapshot}
            active={active && tab === 'installed'}
          />
        )}
        <div hidden={selected !== 'local:todo' || rulesOpen}>
          <AssistantPanel
            active={active && tab === 'installed' && selected === 'local:todo'}
            locale={locale}
            onTaskCountChange={setTodoCount}
          />
        </div>
      </PluginDetails>
    </section>
  )
}
