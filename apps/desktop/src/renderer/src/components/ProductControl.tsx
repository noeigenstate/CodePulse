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
  type HudToolKey,
  type InkCycleInterval,
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
import { useInkStatus, minutesUntil } from '../lib/useInkStatus.js'
import { PageHeader } from './PageHeader.js'
import './product-control.css'
import './device-display.css'

const HUD_TOOLS: { key: HudToolKey; label: string }[] = [
  { key: 'codex', label: 'Codex' },
  { key: 'claude_code', label: 'Claude Code' },
  { key: 'grok', label: 'Grok' },
  { key: 'kimi', label: 'Kimi' },
  { key: 'antigravity', label: 'Antigravity' },
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
        if (alive) setError(locale === 'zh' ? 'HUD 预览暂不可用。' : 'HUD preview unavailable.')
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
    <div className="product-config-grid">
      <section className="product-preview-stage hud-preview-stage">
        <div className="product-preview-label">
          <span>{zh ? '画面预览' : 'Preview'}</span>
          <span>
            {settings.projectLayout === 'grid'
              ? zh
                ? 'HUD · 紧凑矩阵'
                : 'HUD · Grid'
              : zh
                ? 'HUD · 单列排序'
                : 'HUD · List'}{' '}
            · {settings.hudOpacity}%
          </span>
        </div>
        {snapshot ? (
          <HudPreview snapshot={snapshot} locale={locale} settings={settings} />
        ) : (
          <p className="product-empty">
            {error ||
              (product.shell.hudAvailable
                ? zh
                  ? '正在读取 HUD…'
                  : 'Loading HUD…'
                : zh
                  ? '当前安装未提供 HUD。'
                  : 'HUD is not installed.')}
          </p>
        )}
        <p className="product-caption">
          {zh ? 'HUD 改动立即生效' : 'HUD changes take effect immediately'}
        </p>
      </section>
      <aside className="product-config hud-inline-config">
        <div className="product-config-heading">
          <h2>{zh ? 'HUD 配置' : 'HUD Settings'}</h2>
          <small>
            {product.shell.hudVisible ? (zh ? '已打开' : 'Open') : zh ? '已收起' : 'Hidden'}
          </small>
        </div>

        <button
          type="button"
          className="product-button primary hud-toggle-btn"
          disabled={!product.shell.hudAvailable}
          onClick={() => void product.setHudVisible(!product.shell.hudVisible)}
        >
          {product.shell.hudVisible ? (zh ? '收起 HUD' : 'Hide HUD') : zh ? '开启 HUD' : 'Open HUD'}
        </button>

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

        <h3>{zh ? '橙色提示动效' : 'Attention Effect'}</h3>
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
  )
}

type CliVisibility = Record<CliToolType, boolean>
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function inkChanges(
  plan: InkDisplayPlan,
  display: DeviceDisplayConfig,
  savedPlan: InkDisplayPlan,
  savedDisplay?: DeviceDisplayConfig,
): string[] {
  return [
    ...(['ambient', 'todos'] as const).filter(
      (item) => plan.items.includes(item) !== savedPlan.items.includes(item),
    ),
    ...(plan.mode !== savedPlan.mode ? ['mode'] : []),
    ...(plan.intervalMinutes !== savedPlan.intervalMinutes ? ['dwell'] : []),
    ...(savedDisplay && !equal(display, savedDisplay) ? ['display'] : []),
  ]
}

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
  const [offlineSavedCount, setOfflineSavedCount] = useState(0)
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
  const connectedRef = useRef(connected)
  connectedRef.current = connected
  const offlineBase = useRef<{ plan: InkDisplayPlan; display: DeviceDisplayConfig }>()
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
  useEffect(() => {
    if (connected) {
      offlineBase.current = undefined
      setOfflineSavedCount(0)
    } else if (ink && displaySnap && !offlineBase.current) {
      offlineBase.current = { plan: savedPlan, display: displaySnap.config }
    }
  }, [connected, ink?.connection, displaySnap?.config, savedPlan])

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
        if (alive) acceptDisplay(snapshot)
      } catch {
        if (alive) setMessage(zh ? '读取画面失败，请重试' : 'Could not read the screen. Retry.')
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

  const display = filterDisplay(displayDraft)
  const pending = inkChanges(plan, display, savedPlan, displaySnap?.config)
  const count = pending.length
  const signature = JSON.stringify([plan, display])
  const applyAll = useCallback(
    async (offlineCount = 0) => {
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
        if (offlineCount && !connectedRef.current && offlineBase.current) {
          setOfflineSavedCount(
            inkChanges(
              result.shell.inkPlan,
              result.display.config,
              offlineBase.current.plan,
              offlineBase.current.display,
            ).length,
          )
        }
      } catch {
        failedRef.current = JSON.stringify([request.plan, request.display])
        if (aliveRef.current)
          setMessage(
            zh
              ? '保存失败，原有配置已保留，请重试'
              : 'Save failed. Previous settings were kept. Retry.',
          )
      } finally {
        busyRef.current = false
        if (aliveRef.current) setSaving(false)
      }
    },
    [acceptDisplay, filterDisplay, zh],
  )
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
    const timer = setTimeout(() => void applyAll(count), 400)
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
  const sample = useMemo(
    () => (source === 'live' ? undefined : createDeviceDensityPreview(display, source)),
    [source, signature],
  )
  const status = sample ?? displaySnap?.status
  const showing = ink?.showing
  const caption = sample
    ? zh
      ? '样例 · 不是设备画面'
      : 'Sample · not the device screen'
    : !connected
      ? zh
        ? '预览 · 设备未连接，这是连接后会显示的画面'
        : 'Preview · what will display when connected'
      : ink?.temporary && showing?.kind !== 'work'
        ? zh
          ? `正在显示 · 临时展示 · 剩 ${minutesUntil(ink.temporary.until)} 分钟`
          : `Showing · temporary · ${minutesUntil(ink.temporary.until)} min left`
        : zh
          ? `正在显示 · ${showing?.kind === 'work' || !showing ? '工作画面' : showing.kind === 'todos' ? '待办' : `桌边内容 · ${showing.title}`}`
          : `Showing · ${showing?.kind === 'work' || !showing ? 'Work screen' : showing.kind === 'todos' ? 'Tasks' : `Desk content · ${showing.title}`}`
  const nextAuto = ambient?.nextAutoAt
    ? new Date(ambient.nextAutoAt).toLocaleTimeString(zh ? 'zh-CN' : 'en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : null
  const applyText = saving
    ? zh
      ? '正在保存…'
      : 'Saving…'
    : connected
      ? count
        ? zh
          ? `${count} 项待应用`
          : `${count} pending changes`
        : zh
          ? '已与设备同步'
          : 'Synced with the device'
      : offlineSavedCount
        ? zh
          ? `${offlineSavedCount} 项改动已保存，连接后自动应用`
          : `${offlineSavedCount} changes saved; applies on connection`
        : count
          ? zh
            ? `${count} 项改动待保存`
            : `${count} changes to save`
          : zh
            ? '未连接 · 连接后按此节目单显示'
            : 'Disconnected · this playlist will display on connection'
  const badge = (id: string) =>
    pending.includes(id) ? <span className="ink-pending">{zh ? '待应用' : 'Pending'}</span> : null
  const workOptions = (
    <details className="ink-work-options">
      <summary>
        {zh ? '画面细项' : 'Work-screen details'}
        {badge('display')}
      </summary>
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
              {mode === 'hud' ? (zh ? '工作状态' : 'Work status') : zh ? '用量看板' : 'Usage board'}
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
            <span>{zh ? '用量指标' : 'Usage metric'}</span>
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

  return (
    <div className="ink-control-workspace">
      <div className="ink-preview-column">
        {ink && !connected && (
          <section className="ink-empty-card">
            <div>
              <h2>{zh ? '尚未连接墨水屏' : 'No e-paper device connected'}</h2>
              <p>
                {zh
                  ? '连接后自动按节目单显示。现在可以先编辑节目单，改动会先保存，连接后自动应用。'
                  : 'Edit the playlist now. Changes are saved and apply automatically when the device connects.'}
              </p>
            </div>
            <button
              type="button"
              className="product-button primary"
              aria-expanded={connectOpen}
              onClick={() => setConnectOpen((open) => !open)}
            >
              {connectOpen
                ? zh
                  ? '收起连接'
                  : 'Hide connection'
                : zh
                  ? '连接设备'
                  : 'Connect device'}
            </button>
          </section>
        )}
        {connectOpen && !connected && active && (
          <section className="ink-connection-panel">
            <DeviceProvisioningPanel copy={deviceCopy} />
          </section>
        )}
        <section className="product-preview-stage ink-preview-card">
          <h2>{zh ? '画面预览' : 'Screen preview'}</h2>
          <p className="ink-preview-caption" role="status">
            {caption}
          </p>
          {status ? (
            <DeviceScreenPreview
              status={status}
              active={active}
              sample={Boolean(sample)}
              live={!sample}
              fit
              collapsibleOptions
              options={
                <div className="product-sample-options">
                  <span>{zh ? '任务样例' : 'Task samples'}</span>
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
                        {value === 'live'
                          ? zh
                            ? '实时'
                            : 'Live'
                          : `${value} ${zh ? '任务' : 'tasks'}`}
                      </button>
                    ))}
                  </div>
                </div>
              }
            />
          ) : (
            <p className="product-empty">
              {zh ? '正在生成墨水屏预览…' : 'Loading e-paper preview...'}
            </p>
          )}
        </section>
      </div>
      <section className="product-config ink-config" aria-label={zh ? '节目单' : 'Playlist'}>
        <div className="product-config-heading">
          <h2>{zh ? '节目单' : 'Playlist'}</h2>
          <p className="product-caption">
            {zh
              ? '墨水屏上显示什么，只在这里决定'
              : 'Choose what appears on the e-paper screen here'}
          </p>
        </div>
        <div className="ink-playlist-row">
          <ProductIcon name="work" />
          <div className="ink-playlist-text">
            <strong>{zh ? '工作画面' : 'Work screen'}</strong>
            <span>{zh ? '会话状态与实时余量' : 'Sessions and live allowances'}</span>
          </div>
          <span className="ink-work-lock">{zh ? '至少保留一项' : 'Always included'}</span>
        </div>
        {workOptions}
        <div className="ink-playlist-row">
          <ProductIcon name="ambient" />
          <div className="ink-playlist-text">
            <strong>
              {zh ? '桌边内容' : 'Desk content'}
              {badge('ambient')}
            </strong>
            <span>
              {ambient
                ? zh
                  ? `今日 ${ambient.shownToday}/${ambient.config.dailyLimit}${nextAuto ? ` · 下次最早 ${nextAuto}` : ' · 暂无可用时段'}`
                  : `Today ${ambient.shownToday}/${ambient.config.dailyLimit}${nextAuto ? ` · Earliest ${nextAuto}` : ' · No eligible time'}`
                : '…'}
            </span>
            <button
              type="button"
              className="product-feature-link"
              onClick={() => void product.navigate('ambient')}
            >
              {zh ? '内容与规则 →' : 'Content & rules →'}
            </button>
          </div>
          <button
            type="button"
            className="ink-switch"
            role="switch"
            aria-label={zh ? '桌边内容加入节目单' : 'Include desk content'}
            aria-checked={plan.items.includes('ambient')}
            disabled={plan.mode === 'single'}
            onClick={() => toggleItem('ambient')}
          />
        </div>
        <div className="ink-playlist-row">
          <ProductIcon name="tasks" />
          <div className="ink-playlist-text">
            <strong>
              {zh ? '待办与提醒' : 'Tasks & reminders'}
              {badge('todos')}
            </strong>
            <span>{zh ? '本地事项与到期时间' : 'Local tasks and due times'}</span>
            <button
              type="button"
              className="product-feature-link"
              onClick={() => void product.navigate('assistant')}
            >
              {zh ? '管理 →' : 'Manage'}
            </button>
          </div>
          <button
            type="button"
            className="ink-switch"
            role="switch"
            aria-label={zh ? '待办与提醒加入节目单' : 'Include tasks & reminders'}
            aria-checked={plan.items.includes('todos')}
            disabled={plan.mode === 'single'}
            onClick={() => toggleItem('todos')}
          />
        </div>
        <div className="ink-plan-options">
          <div className="ink-plan-option">
            <span>
              {zh ? '显示方式' : 'Display mode'}
              {badge('mode')}
            </span>
            <div
              className="product-segments"
              role="group"
              aria-label={zh ? '显示方式' : 'Display mode'}
            >
              {(['single', 'cycle'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={plan.mode === mode}
                  onClick={() => {
                    setPlan((current) => ({ ...current, mode, fixed: 'work' }))
                    setMessage('')
                  }}
                >
                  {mode === 'single' ? (zh ? '固定' : 'Fixed') : zh ? '轮播' : 'Cycle'}
                </button>
              ))}
            </div>
          </div>
          <label className="ink-plan-option">
            <span>
              {zh ? '每项停留' : 'Dwell per item'}
              {badge('dwell')}
            </span>
            <select
              aria-label={zh ? '每项停留' : 'Dwell per item'}
              value={plan.intervalMinutes}
              disabled={plan.mode === 'single'}
              onChange={(event) => {
                setPlan((current) => ({
                  ...current,
                  intervalMinutes: Number(event.target.value) as InkCycleInterval,
                }))
                setMessage('')
              }}
            >
              {[5, 10, 15, 30].map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} {zh ? '分钟' : 'min'}
                </option>
              ))}
            </select>
          </label>
          {plan.mode === 'single' && (
            <p className="product-caption">
              {zh ? '固定模式不轮播' : 'Fixed mode does not rotate'}
            </p>
          )}
        </div>
        <p className="product-caption">
          {zh ? '用量看板暂不支持墨水屏' : 'The usage dashboard is not available on e-paper'}
        </p>
        <p className="product-caption">
          {zh
            ? '临时展示会暂时插到当前画面前，到时自动回到节目单。'
            : 'A temporary display overrides the current screen, then returns to the playlist.'}
        </p>
        <footer className="product-config-actions" aria-live="polite">
          <strong>{applyText}</strong>
          {connected && count > 0 && (
            <button
              type="button"
              className="product-button primary"
              disabled={saving || !displaySnap || !product.ready}
              onClick={() => void applyAll()}
            >
              {zh ? '应用到设备' : 'Apply to device'}
            </button>
          )}
          {message && (
            <p role="alert">
              {message}
              <button
                type="button"
                className="product-feature-link"
                disabled={saving}
                onClick={() => void applyAll(connected ? 0 : count)}
              >
                {zh ? '重试' : 'Retry'}
              </button>
            </p>
          )}
        </footer>
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
  usagePreview?: ReactNode
  active: boolean
  cliVisibility?: CliVisibility
}): JSX.Element {
  const zh = locale === 'zh',
    target = product.target
  const ink = useInkStatus()
  const [visited, setVisited] = useState(new Set([target]))
  const desktopContent = useRef(desktopPreview)
  if (active && target === 'desktop') desktopContent.current = desktopPreview
  useEffect(() => {
    setVisited((previous) => (previous.has(target) ? previous : new Set([...previous, target])))
  }, [target])
  const inkConnection = !ink
    ? zh
      ? '读取中…'
      : 'Loading...'
    : ink.connection === 'connected'
      ? zh
        ? '已连接'
        : 'Connected'
      : ink.connection === 'server-off'
        ? zh
          ? '服务未开启'
          : 'Service off'
        : zh
          ? '未连接'
          : 'Disconnected'
  return (
    <div className="product-scroll product-control">
      <PageHeader
        title={zh ? '控制' : 'Control'}
        subtitle={zh ? '选择要配置的展示端' : 'Choose a presentation to configure'}
        actions={
          <button
            type="button"
            className="product-button"
            disabled={!product.ready}
            onClick={() => void product.setFocus(true)}
          >
            <ProductIcon name="focus" />
            {zh ? '专注模式' : 'Focus mode'}
          </button>
        }
      />
      <div className="product-tabs-label" id="control-target-label">
        {zh ? '配置展示端' : 'Configure presentation'}
      </div>
      <div className="product-surface-tabs" role="tablist" aria-labelledby="control-target-label">
        {(['desktop', 'hud', 'ink'] as const).map((value) => (
          <button
            type="button"
            key={value}
            id={`endpoint-${value}`}
            role="tab"
            aria-selected={target === value}
            aria-controls={`control-panel-${value}`}
            onClick={() => void product.selectTarget(value)}
            onKeyDown={(event) => {
              const values = ['desktop', 'hud', 'ink'] as const
              let index = values.indexOf(value)
              if (event.key === 'ArrowRight') index = (index + 1) % 3
              else if (event.key === 'ArrowLeft') index = (index + 2) % 3
              else if (event.key === 'Home') index = 0
              else if (event.key === 'End') index = 2
              else return
              event.preventDefault()
              document.getElementById(`endpoint-${values[index]}`)?.focus()
              void product.selectTarget(values[index]!)
            }}
            tabIndex={target === value ? 0 : -1}
          >
            <ProductIcon name={value} />
            <span>
              <strong>{TARGET_NAMES[value][zh ? 0 : 1]}</strong>
              <small>
                <i
                  className={`control-connection-dot ${value === 'desktop' || (value === 'hud' ? product.shell.hudVisible : ink?.connection === 'connected') ? 'is-on' : ''}`}
                />
                {value === 'desktop'
                  ? zh
                    ? '已打开'
                    : 'Open'
                  : value === 'hud'
                    ? product.shell.hudVisible
                      ? zh
                        ? '已打开'
                        : 'Open'
                      : zh
                        ? '已收起'
                        : 'Hidden'
                    : inkConnection}
              </small>
            </span>
          </button>
        ))}
      </div>
      <section
        id="control-panel-desktop"
        role="tabpanel"
        aria-labelledby="endpoint-desktop"
        hidden={target !== 'desktop'}
        className="product-control-surface"
      >
        {(target === 'desktop' || visited.has('desktop')) && (
          <div className="product-desktop-panel">
            <div className="product-console-live-stage">{desktopContent.current}</div>
            <p className="product-caption">
              {zh ? '显示哪些 CLI 由 ' : 'Visible tools are controlled by '}
              <button
                type="button"
                className="product-feature-link"
                onClick={() => void product.navigate('settings')}
              >
                {zh ? '设置 › 显示的 CLI' : 'Settings / Visible CLI tools'}
              </button>
              {zh ? ' 决定' : ''}
            </p>
          </div>
        )}
      </section>
      <section
        id="control-panel-hud"
        role="tabpanel"
        aria-labelledby="endpoint-hud"
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
        role="tabpanel"
        aria-labelledby="endpoint-ink"
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
