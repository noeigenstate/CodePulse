import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  DEFAULT_DEVICE_DISPLAY,
  DEFAULT_HUD_SETTINGS,
  DEFAULT_INK_PLAN,
  DISPLAY_AGENT_TYPES,
  type AmbientSnapshot,
  type DeviceDisplayConfig,
  type DeviceDisplaySnapshot,
  type HudAppearanceSettings,
  type HudSurfaceStyle,
  type HudToolKey,
  type InkDisplayPlan,
  type InkScreenStatus,
  type StatusSnapshot,
} from '@codepulse/shared'
import { HudPreview } from '@hud/components/HudPreview'
import { ProductIcon, TARGET_NAMES, type ProductNavigation } from './ProductFrame.js'
import { DeviceScreenPreview } from './DeviceScreenPreview.js'
import { DeviceProvisioningPanel } from './DeviceProvisioningPanel.js'
import { createDeviceDensityPreview, type DevicePreviewSource } from './device-density-preview.js'
import type { DeviceProvisioningCopy, Locale } from '../lib/i18n.js'
import type { CliToolType } from '../lib/dashboardSettings.js'
import { useInkStatus } from '../lib/useInkStatus.js'
import { PageHeader } from './PageHeader.js'
import {
  inkPlanChoice,
  selectInkPlan,
  inkControlChanges,
  nextInkBaseline,
  type InkBaseline,
} from './product-control-state.js'
import './product-control.css'
import './device-display.css'

const HUD_TOOLS: { key: HudToolKey; label: string }[] = [
  { key: 'codex', label: 'Codex' },
  { key: 'claude_code', label: 'Claude Code' },
  { key: 'grok', label: 'Grok' },
  { key: 'kimi', label: 'Kimi' },
  { key: 'antigravity', label: 'Antigravity' },
]

const HUD_STYLE_OPTIONS: { value: HudSurfaceStyle; zh: string; en: string }[] = [
  { value: 'panel', zh: '面板', en: 'Panel' },
  { value: 'island', zh: '灵动岛', en: 'Island' },
  { value: 'pills', zh: '胶囊流', en: 'Pills' },
  { value: 'edge', zh: '边缘抽屉', en: 'Edge drawer' },
  { value: 'orb', zh: '悬浮球', en: 'Orb' },
]

const INK_AGENT_NAMES = { codex: 'Codex', claude_code: 'Claude', grok: 'Grok' } as const
const RETENTION_OPTIONS: {
  value: HudAppearanceSettings['resultRetentionMinutes']
  zh: string
  en: string
}[] = [
  { value: 10, zh: '10 分钟', en: '10m' },
  { value: 30, zh: '30 分钟', en: '30m' },
  { value: 60, zh: '1 小时', en: '1h' },
  { value: 120, zh: '2 小时', en: '2h' },
  { value: 240, zh: '4 小时', en: '4h' },
]

export function HudWorkspace({
  active,
  locale,
  product,
  cliVisibility,
}: {
  active: boolean
  locale: Locale
  product: ProductNavigation
  cliVisibility?: Record<CliToolType, boolean>
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>()
  const [error, setError] = useState('')
  const settings = product.shell.hudSettings ?? DEFAULT_HUD_SETTINGS
  useEffect(() => {
    if (!active || !product.shell.hudAvailable) return
    let alive = true,
      busy = false,
      pending = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      if (busy) {
        pending = true
        return
      }
      busy = true
      try {
        const s = await window.codepulse.getHudPreview()
        if (alive) {
          setSnapshot(s)
          setError('')
        }
      } catch {
        if (alive)
          setError(locale === 'zh' ? '悬浮窗预览暂不可用。' : 'Overlay preview unavailable.')
      } finally {
        busy = false
        if (alive && pending) {
          pending = false
          schedule()
        }
      }
    }
    const schedule = () => {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined
          void read()
        }, 180)
    }
    const stop = window.codepulse.onStatus(schedule)
    void read()
    return () => {
      alive = false
      stop()
      clearTimeout(timer)
    }
  }, [active, product.shell.hudAvailable, locale])

  const zh = locale === 'zh'
  const update = (patch: Partial<HudAppearanceSettings>) => {
    void product.setHudSettings(patch)
  }

  return (
    <div className="hud-control-workspace">
      <header className="hud-workspace-header">
        <button
          type="button"
          className={`product-button hud-toggle-btn${product.shell.hudVisible ? '' : ' primary'}`}
          disabled={!product.shell.hudAvailable}
          onClick={() => void product.setHudVisible(!product.shell.hudVisible)}
        >
          {product.shell.hudVisible
            ? zh
              ? '收起悬浮窗'
              : 'Hide overlay'
            : zh
              ? '开启悬浮窗'
              : 'Open overlay'}
        </button>
      </header>
      <div className="product-config-grid">
        <section className="product-preview-stage hud-preview-stage">
          {snapshot ? (
            <HudPreview snapshot={snapshot} locale={locale} settings={settings} />
          ) : (
            <p className="product-empty">
              {error ||
                (product.shell.hudAvailable
                  ? zh
                    ? '正在读取悬浮窗…'
                    : 'Loading overlay…'
                  : zh
                    ? '当前安装未提供悬浮窗。'
                    : 'Overlay is not installed.')}
            </p>
          )}
        </section>
        <aside className="product-config hud-inline-config">
          <h3>{zh ? '悬浮窗样式' : 'Overlay style'}</h3>
          <div className="product-segments is-grid">
            {HUD_STYLE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={settings.hudStyle === option.value}
                onClick={() => update({ hudStyle: option.value })}
              >
                {zh ? option.zh : option.en}
              </button>
            ))}
          </div>

          {settings.hudStyle === 'panel' && (
            <>
              <h3>{zh ? '项目布局' : 'Project Layout'}</h3>
              <div className="product-segments">
                <button
                  type="button"
                  aria-pressed={settings.projectLayout === 'list'}
                  onClick={() => update({ projectLayout: 'list' })}
                >
                  {zh ? '单列排序' : 'List'}
                </button>
                <button
                  type="button"
                  aria-pressed={settings.projectLayout === 'grid'}
                  onClick={() => update({ projectLayout: 'grid' })}
                >
                  {zh ? '紧凑矩阵' : 'Compact Grid'}
                </button>
              </div>
            </>
          )}

          <h3>{zh ? '外观主题' : 'Theme'}</h3>
          <div className="product-segments">
            <button
              type="button"
              aria-pressed={settings.theme === 'light'}
              onClick={() => update({ theme: 'light' })}
            >
              {zh ? '浅色' : 'Light'}
            </button>
            <button
              type="button"
              aria-pressed={settings.theme === 'dark'}
              onClick={() => update({ theme: 'dark' })}
            >
              {zh ? '深色' : 'Dark'}
            </button>
            <button
              type="button"
              aria-pressed={settings.theme === 'auto'}
              onClick={() => update({ theme: 'auto' })}
            >
              {zh ? '自动' : 'Auto'}
            </button>
          </div>

          <div className="hud-setting-row">
            <div className="hud-setting-label">
              <span>{zh ? '面板背景不透明度' : 'Background Opacity'}</span>
              <strong>{settings.hudOpacity}%</strong>
            </div>
            <input
              type="range"
              min={20}
              max={100}
              step={1}
              value={settings.hudOpacity}
              onChange={(e) => update({ hudOpacity: Number(e.target.value) })}
              className="hud-opacity-slider"
            />
          </div>

          <h3>{zh ? '提示动效' : 'Attention Effect'}</h3>
          <div className="product-segments">
            <button
              type="button"
              aria-pressed={settings.attentionEffect === 'steady'}
              onClick={() => update({ attentionEffect: 'steady' })}
            >
              {zh ? '常亮' : 'Steady'}
            </button>
            <button
              type="button"
              aria-pressed={settings.attentionEffect === 'breathe'}
              onClick={() => update({ attentionEffect: 'breathe' })}
            >
              {zh ? '呼吸' : 'Breathe'}
            </button>
            <button
              type="button"
              aria-pressed={settings.attentionEffect === 'pulse'}
              onClick={() => update({ attentionEffect: 'pulse' })}
            >
              {zh ? '脉冲' : 'Pulse'}
            </button>
          </div>

          <label className="hud-inline-check">
            <input
              type="checkbox"
              checked={settings.autoReveal}
              onChange={(e) => update({ autoReveal: e.target.checked })}
            />
            <span>{zh ? '有提醒时自动显示悬浮窗' : 'Show the overlay when an alert arrives'}</span>
          </label>

          <label className="product-cycle-row">
            <span>{zh ? '卡片停留时长' : 'Card Retention'}</span>
            <select
              value={settings.resultRetentionMinutes}
              onChange={(e) =>
                update({
                  resultRetentionMinutes: Number(
                    e.target.value,
                  ) as HudAppearanceSettings['resultRetentionMinutes'],
                })
              }
            >
              {RETENTION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {zh ? opt.zh : opt.en}
                </option>
              ))}
            </select>
          </label>

          <label className="hud-inline-check">
            <input
              type="checkbox"
              checked={settings.showUsageStrip}
              onChange={(e) => update({ showUsageStrip: e.target.checked })}
            />
            <span>{zh ? '显示底部用量行' : 'Show bottom usage strip'}</span>
          </label>

          <h3>{zh ? '显示的 CLI 工具' : 'Visible CLI Tools'}</h3>
          <div className="hud-tools-grid">
            {HUD_TOOLS.filter((tool) => cliVisibility?.[tool.key] !== false).map((tool) => (
              <label key={tool.key} className="hud-inline-check">
                <input
                  type="checkbox"
                  checked={settings.visibleTools[tool.key] !== false}
                  onChange={(e) =>
                    update({
                      visibleTools: {
                        ...settings.visibleTools,
                        [tool.key]: e.target.checked,
                      },
                    })
                  }
                />
                <span>{tool.label}</span>
              </label>
            ))}
          </div>

          {error && (
            <p role="status" className="product-caption">
              {error}
            </p>
          )}
        </aside>
      </div>
    </div>
  )
}

type CliVisibility = Record<CliToolType, boolean>
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function InkControlWorkspace({
  active,
  locale,
  product,
  deviceCopy,
  ink,
  cliVisibility,
}: {
  active: boolean
  locale: Locale
  product: ProductNavigation
  deviceCopy: DeviceProvisioningCopy
  ink?: InkScreenStatus
  cliVisibility?: CliVisibility
}): JSX.Element {
  const zh = locale === 'zh'
  const connected = ink?.connection === 'connected'
  const savedPlan = product.shell.inkPlan ?? DEFAULT_INK_PLAN
  const [plan, setPlan] = useState<InkDisplayPlan>(savedPlan)
  const [displaySnap, setDisplaySnap] = useState<DeviceDisplaySnapshot>()
  const [displayDraft, setDisplayDraft] = useState<DeviceDisplayConfig>({
    ...DEFAULT_DEVICE_DISPLAY,
    agents: [...DEFAULT_DEVICE_DISPLAY.agents],
  })
  const [ambient, setAmbient] = useState<AmbientSnapshot>()
  const [source, setSource] = useState<DevicePreviewSource>('live')
  const [connectOpen, setConnectOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [temporaryError, setTemporaryError] = useState('')
  const [endingTemporary, setEndingTemporary] = useState(false)
  const [todoCount, setTodoCount] = useState<number>()
  const savedDisplayRef = useRef<DeviceDisplayConfig>()
  const savedPlanRef = useRef(savedPlan)
  const draftRef = useRef(displayDraft)
  const planRef = useRef(plan)
  const busyRef = useRef(false)
  const failedRef = useRef('')
  const aliveRef = useRef(true)
  const scheduleRef = useRef<() => void>(() => {})
  draftRef.current = displayDraft
  planRef.current = plan
  const visibilityRef = useRef(cliVisibility)
  visibilityRef.current = cliVisibility
  const filterDisplay = useCallback(
    (display: DeviceDisplayConfig): DeviceDisplayConfig => ({
      ...display,
      agents: display.agents.filter((agent) => visibilityRef.current?.[agent] !== false),
    }),
    [],
  )

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])
  useEffect(() => {
    const previous = savedPlanRef.current
    setPlan((draft) => (equal(draft, previous) ? savedPlan : draft))
    savedPlanRef.current = savedPlan
  }, [savedPlan])
  useEffect(() => {
    setDisplayDraft((draft) => {
      const next = filterDisplay(draft)
      return equal(next, draft) ? draft : next
    })
  }, [cliVisibility, filterDisplay])
  const acceptDisplay = useCallback(
    (snapshot: DeviceDisplaySnapshot) => {
      const previous = savedDisplayRef.current
      const dirty = previous && !equal(draftRef.current, previous)
      savedDisplayRef.current = snapshot.config
      setDisplaySnap(snapshot)
      if (!dirty) setDisplayDraft(filterDisplay(snapshot.config))
    },
    [filterDisplay],
  )
  useEffect(
    () =>
      window.codepulse.onDeviceDisplay((snapshot) => {
        acceptDisplay(snapshot)
        scheduleRef.current()
      }),
    [acceptDisplay],
  )
  useEffect(() => {
    if (!active) return
    let alive = true,
      busy = false,
      pending = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      if (busy) {
        pending = true
        return
      }
      busy = true
      try {
        const snapshot = await window.codepulse.getDeviceDisplay()
        if (alive) {
          acceptDisplay(snapshot)
          setPreviewError('')
        }
      } catch {
        if (alive)
          setPreviewError(zh ? '读取画面失败，请重试' : 'Could not read the screen. Retry.')
      } finally {
        busy = false
        if (alive && pending) {
          pending = false
          schedule()
        }
      }
    }
    const schedule = () => {
      if (!alive || timer) return
      timer = setTimeout(() => {
        timer = undefined
        void read()
      }, 160)
    }
    scheduleRef.current = schedule
    const stop = window.codepulse.onStatus(schedule)
    schedule()
    return () => {
      alive = false
      stop()
      clearTimeout(timer)
      scheduleRef.current = () => {}
    }
  }, [active, acceptDisplay, zh])
  useEffect(() => {
    scheduleRef.current()
  }, [
    ink?.current,
    ink?.showing.kind,
    ink?.showing.kind === 'work' ? '' : ink?.showing.title,
    ink?.temporary?.until,
  ])
  useEffect(() => {
    if (!active) return
    let alive = true,
      received = false
    const stop = window.codepulse.onAmbient((snapshot) => {
      received = true
      if (alive) setAmbient(snapshot)
    })
    void window.codepulse
      .getAmbient()
      .then((snapshot) => {
        if (alive && !received) setAmbient(snapshot)
      })
      .catch(() => {})
    return () => {
      alive = false
      stop()
    }
  }, [active])

  useEffect(() => {
    if (!active) return
    let alive = true,
      received = false
    const accept = (snapshot: import('@codepulse/shared').AssistantSnapshot) => {
      if (alive) setTodoCount(snapshot.tasks.filter((task) => task.status === 'pending').length)
    }
    const stop = window.codepulse.onAssistant((snapshot) => {
      received = true
      accept(snapshot)
    })
    void window.codepulse
      .getAssistant()
      .then((snapshot) => {
        if (!received) accept(snapshot)
      })
      .catch(() => {})
    return () => {
      alive = false
      stop()
    }
  }, [active])
  useEffect(() => {
    setTemporaryError('')
  }, [ink?.temporary?.until])

  const display = filterDisplay(displayDraft)
  const pending = inkControlChanges(plan, display, savedPlan, displaySnap?.config)
  const count = pending.length
  // Offline changes auto-apply (the count above drops to zero), but they stay pending for the device.
  const baselineRef = useRef<InkBaseline>()
  baselineRef.current = nextInkBaseline(baselineRef.current, {
    connected,
    saving,
    plan: savedPlan,
    display: displaySnap?.config,
  })
  const offlineCount = baselineRef.current
    ? inkControlChanges(plan, display, baselineRef.current.plan, baselineRef.current.display).length
    : count
  const shownCount = connected ? count : offlineCount
  const signature = JSON.stringify([plan, display])
  const applyAll = useCallback(async () => {
    if (busyRef.current || !savedDisplayRef.current) return
    busyRef.current = true
    setSaving(true)
    setMessage('')
    const request = { plan: planRef.current, display: filterDisplay(draftRef.current) }
    try {
      const result = await window.codepulse.applyInk(request)
      if (!aliveRef.current) return
      failedRef.current = ''
      acceptDisplay(result.display)
      if (equal(planRef.current, request.plan)) setPlan(result.shell.inkPlan)
      if (equal(filterDisplay(draftRef.current), request.display))
        setDisplayDraft(filterDisplay(result.display.config))
    } catch {
      failedRef.current = JSON.stringify([request.plan, request.display])
      if (aliveRef.current) setMessage(zh ? '保存失败，请重试' : 'Save failed. Retry.')
    } finally {
      busyRef.current = false
      if (aliveRef.current) setSaving(false)
    }
  }, [acceptDisplay, filterDisplay, zh])
  useEffect(() => {
    if (
      !active ||
      !ink ||
      connected ||
      !product.ready ||
      !count ||
      saving ||
      !displaySnap ||
      failedRef.current === signature
    )
      return
    const timer = setTimeout(() => void applyAll(), 400)
    return () => clearTimeout(timer)
  }, [
    active,
    ink?.connection,
    connected,
    product.ready,
    count,
    signature,
    saving,
    displaySnap,
    applyAll,
  ])
  const changeDisplay = (patch: Partial<DeviceDisplayConfig>) => {
    setDisplayDraft((current) => filterDisplay({ ...current, ...patch }))
    setMessage('')
  }
  const toggleItem = (item: 'ambient' | 'todos') => {
    setPlan((current) => ({
      ...current,
      fixed: 'work',
      items: current.items.includes(item)
        ? current.items.filter((value) => value !== item)
        : [...current.items, item],
    }))
    setMessage('')
  }
  const endTemporary = async () => {
    setEndingTemporary(true)
    setTemporaryError('')
    try {
      await window.codepulse.endInkTemporary()
      scheduleRef.current()
    } catch {
      if (aliveRef.current)
        setTemporaryError(
          zh ? '未能回到工作画面，请重试' : 'Could not return to the work screen. Retry.',
        )
    } finally {
      if (aliveRef.current) setEndingTemporary(false)
    }
  }
  const sample = useMemo(
    () => (source === 'live' ? undefined : createDeviceDensityPreview(display, source)),
    [source, signature],
  )
  const status = sample ?? displaySnap?.status
  const tag = sample
    ? zh
      ? '样例'
      : 'Sample'
    : !connected
      ? zh
        ? '预览'
        : 'Preview'
      : ink?.temporary && ink.showing.kind !== 'work'
        ? zh
          ? '临时展示'
          : 'Temporary'
        : zh
          ? '当前画面'
          : 'Current screen'
  const headerActions = (
    <>
      {ink && !connected && (
        <button
          type="button"
          className={`product-button${connectOpen ? '' : ' primary'}`}
          aria-expanded={connectOpen}
          aria-controls="ink-provisioning"
          onClick={() => setConnectOpen((open) => !open)}
        >
          {connectOpen ? (zh ? '收起' : 'Collapse') : zh ? '连接设备' : 'Connect device'}
        </button>
      )}
      {ink?.temporary && (
        <button
          type="button"
          data-ink-temporary-end
          className="product-button"
          disabled={endingTemporary}
          onClick={() => void endTemporary()}
        >
          {endingTemporary ? (zh ? '返回中…' : 'Returning…') : zh ? '回到工作画面' : 'Back to work'}
        </button>
      )}
    </>
  )
  const previewOptions = (
    <div className="product-sample-options">
      <span>{zh ? '样例' : 'Samples'}</span>
      <div
        className="product-sample-buttons"
        role="group"
        aria-label={zh ? '预览内容' : 'Preview source'}
      >
        {(['live', 3, 6, 9] as DevicePreviewSource[]).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={source === value}
            onClick={() => setSource(value)}
          >
            {value === 'live' ? (zh ? '实时' : 'Live') : `${value} ${zh ? '任务' : 'tasks'}`}
          </button>
        ))}
      </div>
    </div>
  )
  const workOptions = (
    <details className="ink-work-options">
      <summary>{zh ? '画面细项' : 'Work-screen details'}</summary>
      <div className="ink-work-options-body">
        <div
          className="product-segments"
          role="group"
          aria-label={zh ? '工作画面内容' : 'Work-screen content'}
        >
          {(['hud', 'usage'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={display.mode === mode}
              onClick={() => changeDisplay({ mode })}
            >
              {mode === 'hud'
                ? zh
                  ? '工作状态'
                  : 'Work status'
                : zh
                  ? '开销看板'
                  : 'Spending board'}
            </button>
          ))}
        </div>
        <div className="hud-tools-grid">
          {DISPLAY_AGENT_TYPES.filter((agent) => cliVisibility?.[agent] !== false).map((agent) => (
            <label key={agent} className="hud-inline-check">
              <input
                type="checkbox"
                checked={display.agents.includes(agent)}
                onChange={(event) =>
                  changeDisplay({
                    agents: event.target.checked
                      ? [...display.agents, agent]
                      : display.agents.filter((value) => value !== agent),
                  })
                }
              />
              {INK_AGENT_NAMES[agent]}
            </label>
          ))}
        </div>
        <label className="hud-inline-check">
          <input
            type="checkbox"
            checked={display.showQuota}
            onChange={(event) => changeDisplay({ showQuota: event.target.checked })}
          />
          {zh ? '显示余量' : 'Show quota'}
        </label>
        <label className="hud-inline-check">
          <input
            type="checkbox"
            checked={display.showEnvironment}
            onChange={(event) => changeDisplay({ showEnvironment: event.target.checked })}
          />
          {zh ? '显示环境读数' : 'Show environment'}
        </label>
        <label className="hud-inline-check">
          <input
            type="checkbox"
            checked={Boolean(display.inverted)}
            onChange={(event) => changeDisplay({ inverted: event.target.checked })}
          />
          {zh ? '反色显示' : 'Invert screen'}
        </label>
        {display.mode === 'usage' && (
          <label className="product-cycle-row">
            <span>{zh ? '开销指标' : 'Spending metric'}</span>
            <select
              value={display.metric}
              onChange={(event) =>
                changeDisplay({ metric: event.target.value as DeviceDisplayConfig['metric'] })
              }
            >
              <option value="remaining">{zh ? '剩余' : 'Remaining'}</option>
              <option value="used">{zh ? '已用' : 'Used'}</option>
            </select>
          </label>
        )}
      </div>
    </details>
  )

  const openPage = (event: React.MouseEvent, page: 'ambient' | 'assistant') => {
    if ((event.target as Element).closest('[role="switch"]')) return
    void product.navigate(page)
  }
  return (
    <div className="ink-control-workspace">
      <div className="ink-preview-column">
        <section className="product-preview-stage ink-preview-card">
          {status ? (
            <DeviceScreenPreview
              status={status}
              active={active}
              sample={Boolean(sample)}
              live={!sample}
              fit
              compact
              heading={zh ? '画面预览' : 'Screen preview'}
              headerActions={headerActions}
              cornerTag={tag}
              options={previewOptions}
            />
          ) : (
            <>
              <div className="device-preview-header">
                <h2>{zh ? '画面预览' : 'Screen preview'}</h2>
                <div className="device-preview-header-actions">{headerActions}</div>
              </div>
              {!previewError && <p role="status">{zh ? '正在读取画面…' : 'Loading screen…'}</p>}
            </>
          )}
          {previewError && (
            <p className="ink-action-error" role="alert">
              {previewError}
              <button
                type="button"
                className="product-feature-link"
                onClick={() => scheduleRef.current()}
              >
                {zh ? '重试' : 'Retry'}
              </button>
            </p>
          )}
          {temporaryError && (
            <p className="ink-action-error" role="alert">
              {temporaryError}
            </p>
          )}
        </section>
        {connectOpen && !connected && active && (
          <section className="ink-connection-panel" id="ink-provisioning">
            <DeviceProvisioningPanel copy={deviceCopy} />
          </section>
        )}
      </div>
      <section className="product-config ink-config" aria-label={zh ? '节目单' : 'Playlist'}>
        <div className="product-config-heading">
          <h2>{zh ? '节目单' : 'Playlist'}</h2>
        </div>
        <div className="ink-playlist-row ink-work-row">
          <ProductIcon name="work" />
          <strong>{zh ? '工作画面' : 'Work screen'}</strong>
          <svg
            className="ink-work-lock"
            role="img"
            aria-label={zh ? '始终显示工作画面' : 'Work screen always included'}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            <rect x="6" y="11" width="12" height="9" rx="2" />
            <path d="M9 11V8a3 3 0 0 1 6 0v3" />
          </svg>
        </div>
        {workOptions}
        <div className="ink-playlist-row is-linked" onClick={(event) => openPage(event, 'ambient')}>
          <button
            type="button"
            className="ink-row-main"
            aria-label={zh ? '桌边内容' : 'Desk content'}
          >
            <ProductIcon name="ambient" />
            <span className="ink-playlist-text">
              <strong>{zh ? '桌边内容' : 'Desk content'}</strong>
              {ambient && (
                <span>
                  {zh
                    ? `今日 ${ambient.shownToday}/${ambient.config.dailyLimit}`
                    : `Today ${ambient.shownToday}/${ambient.config.dailyLimit}`}
                </span>
              )}
            </span>
          </button>
          <button
            type="button"
            className="ink-switch"
            role="switch"
            aria-label={zh ? '桌边内容加入节目单' : 'Include desk content'}
            aria-checked={plan.items.includes('ambient')}
            disabled={plan.mode === 'single'}
            onClick={(event) => {
              event.stopPropagation()
              toggleItem('ambient')
            }}
          />
          <span className="ink-row-chevron" aria-hidden="true">
            ›
          </span>
        </div>
        <div
          className="ink-playlist-row is-linked"
          onClick={(event) => openPage(event, 'assistant')}
        >
          <button
            type="button"
            className="ink-row-main"
            aria-label={zh ? '待办与提醒' : 'Tasks & reminders'}
          >
            <ProductIcon name="tasks" />
            <span className="ink-playlist-text">
              <strong>{zh ? '待办与提醒' : 'Tasks & reminders'}</strong>
              {todoCount !== undefined && (
                <span>{zh ? `${todoCount} 项待完成` : `${todoCount} pending tasks`}</span>
              )}
            </span>
          </button>
          <button
            type="button"
            className="ink-switch"
            role="switch"
            aria-label={zh ? '待办与提醒加入节目单' : 'Include tasks & reminders'}
            aria-checked={plan.items.includes('todos')}
            disabled={plan.mode === 'single'}
            onClick={(event) => {
              event.stopPropagation()
              toggleItem('todos')
            }}
          />
          <span className="ink-row-chevron" aria-hidden="true">
            ›
          </span>
        </div>
        <select
          className="ink-playback-select"
          aria-label={zh ? '显示方式' : 'Display mode'}
          value={inkPlanChoice(plan)}
          onChange={(event) => {
            setPlan((current) => selectInkPlan(current, event.target.value))
            setMessage('')
          }}
        >
          {[5, 10, 15, 30].map((minutes) => (
            <option key={minutes} value={String(minutes)}>
              {zh ? `轮播 · 每 ${minutes} 分钟` : `Cycle · every ${minutes} min`}
            </option>
          ))}
          <option value="fixed">{zh ? '只显示工作画面' : 'Work screen only'}</option>
        </select>
        {shownCount > 0 && (
          <footer className="product-config-actions" aria-live="polite">
            <strong>
              {connected
                ? zh
                  ? `${count} 项未应用`
                  : `${count} pending changes`
                : zh
                  ? `${shownCount} 项改动，连接后自动应用`
                  : `${shownCount} changes · applied on connection`}
            </strong>
            {connected && (
              <button
                type="button"
                className="product-button primary"
                disabled={saving || !displaySnap || !product.ready}
                onClick={() => void applyAll()}
              >
                {saving ? (zh ? '应用中…' : 'Applying…') : zh ? '应用' : 'Apply'}
              </button>
            )}
          </footer>
        )}
        {message && (
          <p className="ink-action-error" role="alert">
            {message}
            <button
              type="button"
              className="product-feature-link"
              disabled={saving}
              onClick={() => void applyAll()}
            >
              {zh ? '重试' : 'Retry'}
            </button>
          </p>
        )}
      </section>
    </div>
  )
}

export function ProductControl({
  product,
  locale,
  deviceCopy,
  desktopPreview,
  active,
  cliVisibility,
}: {
  product: ProductNavigation
  locale: Locale
  deviceCopy: DeviceProvisioningCopy
  snapshot?: StatusSnapshot
  desktopPreview: ReactNode
  active: boolean
  cliVisibility?: CliVisibility
}): JSX.Element {
  const zh = locale === 'zh',
    target = product.target
  const ink = useInkStatus(active)
  const [visited, setVisited] = useState(new Set([target]))
  const desktopContent = useRef(desktopPreview)
  if (active && target === 'desktop') desktopContent.current = desktopPreview
  useEffect(() => {
    setVisited((previous) => (previous.has(target) ? previous : new Set([...previous, target])))
  }, [target])
  return (
    <div className={`product-scroll product-control${target === 'desktop' ? ' is-desktop' : ''}`}>
      <PageHeader title={TARGET_NAMES[target][zh ? 0 : 1]} />
      <section
        id="control-panel-desktop"
        aria-label={TARGET_NAMES.desktop[zh ? 0 : 1]}
        hidden={target !== 'desktop'}
        className="product-control-surface"
      >
        {(target === 'desktop' || visited.has('desktop')) && (
          <div className="product-console-live-stage">{desktopContent.current}</div>
        )}
      </section>
      <section
        id="control-panel-hud"
        aria-label={TARGET_NAMES.hud[zh ? 0 : 1]}
        hidden={target !== 'hud'}
        className="product-control-surface"
      >
        {(target === 'hud' || visited.has('hud')) && (
          <HudWorkspace
            product={product}
            locale={locale}
            active={active && target === 'hud'}
            cliVisibility={cliVisibility}
          />
        )}
      </section>
      <section
        id="control-panel-ink"
        aria-label={TARGET_NAMES.ink[zh ? 0 : 1]}
        hidden={target !== 'ink'}
        className="product-control-surface"
      >
        {(target === 'ink' || visited.has('ink')) && (
          <InkControlWorkspace
            product={product}
            locale={locale}
            deviceCopy={deviceCopy}
            active={active && target === 'ink'}
            ink={ink}
            cliVisibility={cliVisibility}
          />
        )}
      </section>
    </div>
  )
}
