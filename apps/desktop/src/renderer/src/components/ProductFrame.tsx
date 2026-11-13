import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  normalizeShellPreferences,
  productDestination,
  type DesktopLayout,
  type HudAppearanceSettings,
  type InkDisplayPlan,
  type ProductView,
  type PresentationTarget,
  type ShellSnapshot,
} from '@codepulse/shared'
import { InkNavAnnouncer, InkNavStatus } from './InkStatusBar.js'
import { RailStatus } from './RailStatus.js'
import { RailTip } from './RailTip.js'
import './product-shell.css'

import { inkNavText } from '../lib/inkStatusText.js'
import { NAV_GROUPS, PRODUCT_NAV } from '../lib/productNavigation.js'
import { railShortcutHint } from '../lib/railPreference.js'
import { useInkStatus } from '../lib/useInkStatus.js'
import { useNow } from '../lib/useNow.js'
import type { Locale } from '../lib/i18n.js'
export { NAV_GROUPS, PRODUCT_NAV, TARGET_NAMES } from '../lib/productNavigation.js'

export function ProductIcon({ name }: { name: string }): JSX.Element {
  const paths: Record<string, ReactNode> = {
    work: <path d="M2 12h5l3-8 4 16 3-8h5" />,
    desktop: (
      <>
        <rect x="3" y="3" width="18" height="13" rx="2" />
        <path d="M12 16v5M8 21h8" />
      </>
    ),
    hud: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 9h18M9 9v11" />
      </>
    ),
    ink: (
      <>
        <rect x="5" y="2" width="14" height="20" rx="2" />
        <path d="M10 18h4" />
      </>
    ),
    ambient: (
      <>
        <circle cx="12" cy="12" r="2" />
        <path d="M6 6a8 8 0 0 0 0 12M18 6a8 8 0 0 1 0 12M3 3a12 12 0 0 0 0 18M21 3a12 12 0 0 1 0 18" />
      </>
    ),
    plugins: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <path d="M14 17h7M17.5 14v7" />
      </>
    ),
    usage: <path d="M4 3v17h17M8 16v-5M13 16V7M18 16V4" />,
    tasks: (
      <>
        <rect x="5" y="3" width="16" height="18" rx="2" />
        <path d="m8 9 2 2 4-4M8 16h9" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" />
      </>
    ),
    expand: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16M13 9l3 3-3 3" />
      </>
    ),
    collapse: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16M16 9l-3 3 3 3" />
      </>
    ),
  }
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name] ?? paths.work}
    </svg>
  )
}
export function useProductNavigation() {
  const [shell, setShell] = useState<ShellSnapshot>(() => ({
    ...normalizeShellPreferences(null),
    hudAvailable: false,
    hudVisible: false,
  }))
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [visited, setVisited] = useState(new Set<ProductView>(['window']))
  const [pendingTarget, setPendingTarget] = useState<PresentationTarget>()
  const selection = useRef(0)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    let received = false
    const accept = (s: ShellSnapshot) => {
      if (!alive.current) return
      setShell(s)
      setReady(true)
      setVisited((old) => (old.has(s.view) ? old : new Set([...old, s.view])))
    }
    const stop = window.codepulse.onShell((s) => {
      received = true
      accept(s)
    })
    void window.codepulse
      .getShell()
      .then((s) => {
        if (!received) accept(s)
      })
      .catch(() => {
        if (alive.current) setError('产品导航暂不可用，请通过统一桌面入口启动。')
      })
    return () => {
      alive.current = false
      stop()
    }
  }, [])
  const run = async (action: () => Promise<ShellSnapshot>): Promise<boolean> => {
    setError('')
    try {
      await action()
      return true
    } catch {
      if (alive.current) setError('更改未完成，原有配置已保留，请重试。')
      return false
    }
  }
  const selectTarget = async (target: PresentationTarget): Promise<boolean> => {
    if (target === (pendingTarget ?? shell.target)) return true
    const request = ++selection.current
    // Selection is local UI feedback; saving it must not hold up the next paint.
    setPendingTarget(target)
    const success = await run(async () => {
      const next = await window.codepulse.setPresentationTarget(target)
      if (alive.current && request === selection.current) setShell(next)
      return next
    })
    if (alive.current && request === selection.current) setPendingTarget(undefined)
    return success
  }
  return {
    shell,
    ready,
    visited,
    error,
    view: shell.view,
    target: pendingTarget ?? shell.target,
    navigate: (view: ProductView) => {
      ++selection.current
      setPendingTarget(undefined)
      return run(() => window.codepulse.navigateProduct(view))
    },
    selectTarget,
    setLayout: (layout: DesktopLayout) => run(() => window.codepulse.setDesktopLayout(layout)),
    setInkPlan: (plan: InkDisplayPlan) => run(() => window.codepulse.setInkPlan(plan)),
    setHudSettings: (patch: Partial<HudAppearanceSettings>) =>
      run(() => window.codepulse.setHudSettings(patch)),
    setHudVisible: (visible: boolean) => run(() => window.codepulse.setHudVisible(visible)),
  }
}
export type ProductNavigation = ReturnType<typeof useProductNavigation>
export interface RailToggleProps {
  collapsed: boolean
  onToggle: () => void
  locale: string
  /** `process.platform` of the host; macOS shows ⌘B. */
  platform?: string
}

/** The sidebar's collapse switch, on the first row of the sidebar. */
export function RailToggle({
  collapsed,
  onToggle,
  locale,
  platform,
}: RailToggleProps): JSX.Element {
  const zh = locale === 'zh'
  const shortcut = railShortcutHint(platform)
  const label = zh
    ? collapsed
      ? '展开侧边栏'
      : '收起侧边栏'
    : collapsed
      ? 'Expand sidebar'
      : 'Collapse sidebar'
  return (
    <button
      type="button"
      className="product-rail-toggle"
      aria-label={label}
      aria-expanded={!collapsed}
      aria-keyshortcuts={shortcut.aria}
      onClick={(event) => {
        onToggle()
        // A mouse click must not leave the keyboard focus ring behind; Enter and Space keep it.
        if (event.detail > 0) event.currentTarget.blur()
      }}
    >
      <ProductIcon name={collapsed ? 'expand' : 'collapse'} />
      <RailTip>{`${label} · ${shortcut.text}`}</RailTip>
    </button>
  )
}

/** The sidebar follows connection state independently from the active content page. */
function ProductRail({
  product,
  zh,
  platform,
  titleIcon,
  collapsed,
  runningTasks,
  onToggleRail,
  onLocale,
}: {
  product: ProductNavigation
  zh: boolean
  platform?: string
  titleIcon?: string
  collapsed: boolean
  runningTasks?: number
  onToggleRail: () => void
  onLocale?: () => void
}): JSX.Element {
  const lang: Locale = zh ? 'zh' : 'en'
  const ink = useInkStatus()
  const now = useNow(15000)
  const inkText = ink && inkNavText(ink, now, lang)
  const languageTitle = zh ? 'Switch to English / 切换为英文' : '切换为中文 / Switch to Chinese'
  return (
    <>
      <div className="product-rail-heading">
        <div className="product-rail-top">
          {titleIcon && (
            <>
              <img className="product-rail-logo" alt="" aria-hidden="true" src={titleIcon} />
              <span className="product-rail-name">CodePulse</span>
            </>
          )}
          <RailToggle
            collapsed={collapsed}
            onToggle={onToggleRail}
            locale={lang}
            platform={platform}
          />
        </div>
      </div>
      <nav aria-label={zh ? '功能导航' : 'Navigation'}>
        {NAV_GROUPS.map((group) => (
          <div
            key={group.id}
            className="product-nav-group"
            role="group"
            aria-labelledby={`product-nav-group-${group.id}`}
          >
            <div id={`product-nav-group-${group.id}`} className="product-nav-group-label">
              {zh ? group.label : group.english}
            </div>
            {PRODUCT_NAV.filter((item) => item.group === group.id).map((item) => {
              const name = zh ? item.label : item.english
              const status = item.id === 'ink' ? inkText : undefined
              const tip = status?.name ?? name
              return (
                <button
                  key={item.id}
                  type="button"
                  data-view={item.id}
                  aria-label={status ? tip : undefined}
                  aria-current={
                    productDestination(product.view, product.target).page === item.id
                      ? 'page'
                      : undefined
                  }
                  onClick={() => void product.navigate(item.id)}
                >
                  <span className="product-nav-glyph">
                    <ProductIcon name={item.icon} />
                    {status && <InkNavStatus text={status} />}
                  </span>
                  <span className="product-nav-label">{name}</span>
                  <RailTip>{tip}</RailTip>
                </button>
              )
            })}
          </div>
        ))}
      </nav>
      <InkNavAnnouncer word={inkText?.word} />
      <div className="product-rail-footer">
        {runningTasks !== undefined && (
          <RailStatus tasks={runningTasks} locale={lang} collapsed={collapsed} />
        )}
        <div className="product-settings-row">
          <button
            type="button"
            data-view="settings"
            aria-label={zh ? '设置' : 'Settings'}
            aria-current={product.view === 'settings' ? 'page' : undefined}
            onClick={() => void product.navigate('settings')}
          >
            <ProductIcon name="settings" />
            <span className="product-nav-label">{zh ? '设置' : 'Settings'}</span>
            <RailTip>{zh ? '设置' : 'Settings'}</RailTip>
          </button>
          <button
            type="button"
            className="product-language-toggle"
            onClick={onLocale}
            disabled={!onLocale}
            aria-label={zh ? 'Switch to English' : '切换为中文'}
            title={collapsed ? undefined : languageTitle}
          >
            <span lang="zh-CN" data-active={zh}>
              中
            </span>
            <span aria-hidden="true">/</span>
            <span lang="en" data-active={!zh}>
              EN
            </span>
            <RailTip>{languageTitle}</RailTip>
          </button>
        </div>
      </div>
    </>
  )
}

const noop = () => {}

export function ProductFrame({
  product,
  locale,
  onLocale,
  platform,
  titleIcon,
  collapsed = false,
  runningTasks,
  onToggleRail = noop,
  children,
}: {
  product: ProductNavigation
  locale: string
  onLocale?: () => void
  platform?: string
  /**
   * Windows draws no title bar strip: this brand mark moves into the sidebar's first row and the
   * main area gets a drag band for the system buttons. Elsewhere the native title bar says it.
   */
  titleIcon?: string
  /** The sidebar shows icons only. */
  collapsed?: boolean
  /** Agents running right now; the status above Settings is left out without it. */
  runningTasks?: number
  onToggleRail?: () => void
  children: ReactNode
}): JSX.Element {
  const zh = locale === 'zh'
  return (
    <div className={`product-frame${titleIcon ? ' has-window-controls' : ''}`}>
      <aside className={`product-rail${collapsed ? ' is-collapsed' : ''}`} data-tip-scope>
        <ProductRail
          product={product}
          zh={zh}
          platform={platform}
          titleIcon={titleIcon}
          collapsed={collapsed}
          runningTasks={runningTasks}
          onToggleRail={onToggleRail}
          onLocale={onLocale}
        />
      </aside>
      <div className="product-main">
        {titleIcon && <div className="product-dragbar" />}
        {product.error && (
          <p className="product-attention" role="alert">
            {product.error}
          </p>
        )}
        <main className="product-content">{children}</main>
      </div>
    </div>
  )
}
