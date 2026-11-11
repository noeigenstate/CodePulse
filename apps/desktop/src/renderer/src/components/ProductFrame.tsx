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
import { InkStatusPill } from './InkStatusBar.js'
import './product-shell.css'

import { PRODUCT_NAV } from '../lib/productNavigation.js'
export { PRODUCT_NAV, TARGET_NAMES } from '../lib/productNavigation.js'

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
    focus: (
      <>
        <path d="M8 3v5H3M16 21v-5h5M3 3l5 5M21 21l-5-5" />
      </>
    ),
    expand: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16M13 9l3 3-3 3" />
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
    focusMode: shell.focusMode,
    navigate: (view: ProductView) => {
      ++selection.current
      setPendingTarget(undefined)
      return run(() => window.codepulse.navigateProduct(view))
    },
    selectTarget,
    setFocus: (focus: boolean) => run(() => window.codepulse.setFocusMode(focus)),
    setLayout: (layout: DesktopLayout) => run(() => window.codepulse.setDesktopLayout(layout)),
    setInkPlan: (plan: InkDisplayPlan) => run(() => window.codepulse.setInkPlan(plan)),
    setHudSettings: (patch: Partial<HudAppearanceSettings>) =>
      run(() => window.codepulse.setHudSettings(patch)),
    setHudVisible: (visible: boolean) => run(() => window.codepulse.setHudVisible(visible)),
  }
}
export type ProductNavigation = ReturnType<typeof useProductNavigation>
export function ProductFrame({
  product,
  locale,
  onLocale,
  children,
}: {
  product: ProductNavigation
  locale: string
  onLocale?: () => void
  children: ReactNode
}): JSX.Element {
  const zh = locale === 'zh',
    { view, focusMode } = product
  const returnButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (focusMode) returnButton.current?.focus()
  }, [focusMode])
  return (
    <div className={`product-frame ${focusMode ? 'is-focused' : ''}`}>
      <aside className="product-rail" hidden={focusMode}>
        <div className="product-brand">
          <span className="product-brand-mark">
            <ProductIcon name="work" />
          </span>
          CodePulse
        </div>
        <nav aria-label={zh ? '功能导航' : 'Navigation'}>
          {PRODUCT_NAV.map((item) => (
            <div
              key={item.id}
              className={item.parent ? 'product-nav-child' : undefined}
              data-parent={item.parent}
            >
              <button
                type="button"
                data-view={item.id}
                className={item.parent ? 'is-child' : undefined}
                data-section-active={
                  (item.id === 'ink' &&
                    productDestination(view, product.target).page === 'plugins') ||
                  undefined
                }
                aria-label={
                  item.parent ? (zh ? '墨水屏设备 · 插件' : 'E-paper Device · Plugins') : undefined
                }
                aria-current={
                  productDestination(view, product.target).page === item.id ? 'page' : undefined
                }
                onClick={() => void product.navigate(item.id)}
              >
                <ProductIcon name={item.icon} />
                <span>{zh ? item.label : item.english}</span>
              </button>
            </div>
          ))}
        </nav>
        <div className="product-rail-footer">
          <div className="product-settings-row">
            <button
              type="button"
              data-view="settings"
              aria-label={zh ? '设置' : 'Settings'}
              aria-current={view === 'settings' ? 'page' : undefined}
              onClick={() => void product.navigate('settings')}
            >
              <ProductIcon name="settings" />
              <span>{zh ? '设置' : 'Settings'}</span>
            </button>
            <button
              type="button"
              className="product-language-toggle"
              onClick={onLocale}
              disabled={!onLocale}
              aria-label={zh ? 'Switch to English' : '切换为中文'}
              title={zh ? 'Switch to English / 切换为英文' : '切换为中文 / Switch to Chinese'}
            >
              <span lang="zh-CN" data-active={zh}>
                中
              </span>
              <span aria-hidden="true">/</span>
              <span lang="en" data-active={!zh}>
                EN
              </span>
            </button>
          </div>
          {!focusMode && <InkStatusPill locale={zh ? 'zh' : 'en'} />}
        </div>
      </aside>
      <div className="product-main">
        {focusMode && (
          <header className="product-focusbar">
            <div className="product-brand">
              <span className="product-brand-mark">
                <ProductIcon name="work" />
              </span>
              CodePulse<small>{zh ? '专注模式' : 'Focus'}</small>
            </div>
            <button
              ref={returnButton}
              type="button"
              className="product-button"
              onClick={() => void product.setFocus(false)}
            >
              <ProductIcon name="expand" />
              {zh ? '返回控制台' : 'Back to console'}
            </button>
          </header>
        )}
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
