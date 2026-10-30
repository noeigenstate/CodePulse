import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  DEFAULT_DEVICE_DISPLAY,
  DEFAULT_HUD_SETTINGS,
  DEFAULT_INK_PLAN,
  DISPLAY_AGENT_TYPES,
  type AmbientSnapshot,
  type DesktopLayout,
  type DeviceDisplayConfig,
  type DeviceDisplaySnapshot,
  type DeviceStatusV1,
  type HudAppearanceSettings,
  type HudToolKey,
  type InkCycleInterval,
  type InkDisplayPlan,
  type InkFeatureId,
  type StatusSnapshot,
} from '@codepulse/shared'
import { HudPreview } from '@hud/components/HudPreview'
import { ProductIcon, TARGET_NAMES, type ProductNavigation } from './ProductFrame.js'
import { DeviceScreenPreview } from './DeviceScreenPreview.js'
import { DeviceProvisioningPanel } from './DeviceProvisioningPanel.js'
import { createDeviceDensityPreview, type DevicePreviewSource } from './device-density-preview.js'
import type { DeviceProvisioningCopy, Locale } from '../lib/i18n.js'
import './device-display.css'

const HUD_TOOLS: { key: HudToolKey; label: string }[] = [
  { key: 'codex', label: 'Codex' },
  { key: 'claude_code', label: 'Claude Code' },
  { key: 'grok', label: 'Grok' },
  { key: 'kimi', label: 'Kimi' },
  { key: 'antigravity', label: 'Antigravity' },
]

const INK_AGENT_NAMES = { codex: 'Codex', claude_code: 'Claude', grok: 'Grok' } as const
function inkFeatureLabel(feature: InkFeatureId, zh: boolean): string {
  return ({work: zh ? '工作' : 'Work', ambient: zh ? '多媒体玩法' : 'Multimedia', todos: zh ? '待办与提醒' : 'Tasks & reminders'})[feature]
}

const RETENTION_OPTIONS: { value: HudAppearanceSettings['resultRetentionMinutes']; zh: string; en: string }[] = [
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
}: {
  active: boolean
  locale: Locale
  product: ProductNavigation
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
          {zh
            ? '右侧修改实时同步至预览与独立 HUD 窗口。'
            : 'Changes on the right sync live to the preview and companion HUD window.'}
        </p>
      </section>
      <aside className="product-config hud-inline-config">
        <div className="product-config-heading">
          <h2>{zh ? 'HUD 配置' : 'HUD Settings'}</h2>
          <small>{product.shell.hudVisible ? (zh ? '窗口已开启' : 'Open') : zh ? '窗口已收起' : 'Hidden'}</small>
        </div>

        <button
          type="button"
          className="product-button primary hud-toggle-btn"
          disabled={!product.shell.hudAvailable}
          onClick={() => void product.setHudVisible(!product.shell.hudVisible)}
        >
          {product.shell.hudVisible ? (zh ? '收起 HUD 窗口' : 'Hide HUD Window') : zh ? '开启 HUD 窗口' : 'Open HUD Window'}
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
                resultRetentionMinutes: Number(e.target.value) as HudAppearanceSettings['resultRetentionMinutes'],
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
          {HUD_TOOLS.map((tool) => (
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

function InkControlWorkspace({
  active,
  locale,
  product,
  deviceCopy,
  connectOpen,
}: {
  active: boolean
  locale: Locale
  product: ProductNavigation
  deviceCopy: DeviceProvisioningCopy
  connectOpen: boolean
}): JSX.Element {
  const zh = locale === 'zh'
  const savedPlan = product.shell.inkPlan ?? DEFAULT_INK_PLAN
  const [plan, setPlan] = useState<InkDisplayPlan>(savedPlan)
  const lastSavedPlanRef = useRef<InkDisplayPlan>(savedPlan)

  const [displaySnap, setDisplaySnap] = useState<DeviceDisplaySnapshot>()
  const [displayDraft, setDisplayDraft] = useState<DeviceDisplayConfig>({
    ...DEFAULT_DEVICE_DISPLAY,
    agents: [...DEFAULT_DEVICE_DISPLAY.agents],
  })
  const savedDisplayRef = useRef<DeviceDisplayConfig>()
  const displayDraftRef = useRef(displayDraft)
  displayDraftRef.current = displayDraft

  const [workStatus, setWorkStatus] = useState<DeviceStatusV1>()
  const [previewSource, setPreviewSource] = useState<DevicePreviewSource>('live')
  const [ambientSnap, setAmbientSnap] = useState<AmbientSnapshot>()
  const [ambientPreview, setAmbientPreview] = useState<DeviceStatusV1>()
  const [todoPreview, setTodoPreview] = useState<DeviceStatusV1>()
  const [previewFocus, setPreviewFocus] = useState<InkFeatureId>('work')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const schedulePreview = useRef<() => void>(() => {})
  const acceptSavedDisplay = useCallback((s: DeviceDisplaySnapshot) => {
    const previous = savedDisplayRef.current
    const hasDraft = previous && JSON.stringify(displayDraftRef.current) !== JSON.stringify(previous)
    savedDisplayRef.current = s.config
    setDisplaySnap(s)
    if (!hasDraft && JSON.stringify(displayDraftRef.current) !== JSON.stringify(s.config)) {
      displayDraftRef.current = s.config
      setDisplayDraft(s.config)
    }
  }, [])

  useEffect(() => {
    const prev = lastSavedPlanRef.current
    setPlan((draft) => (JSON.stringify(draft) === JSON.stringify(prev) ? savedPlan : draft))
    lastSavedPlanRef.current = savedPlan
  }, [savedPlan])

  // Saved configuration follows other windows even while hidden; local drafts survive.
  useEffect(() => window.codepulse.onDeviceDisplay((s) => {
    acceptSavedDisplay(s)
    schedulePreview.current()
  }), [acceptSavedDisplay])

  useEffect(() => {
    if (!active) return
    let alive = true, busy = false, pending = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      if (busy) { pending = true; return }
      busy = true
      const draft = savedDisplayRef.current ? displayDraftRef.current : undefined
      try {
        const s = await window.codepulse.getDeviceDisplay(draft)
        if (!alive) return
        acceptSavedDisplay(s)
        // A slow response must not replace a newer configuration preview.
        if (!draft || JSON.stringify(draft) === JSON.stringify(displayDraftRef.current)) setWorkStatus(s.status)
        else pending = true
      } catch {} finally {
        busy = false
        if (alive && pending) { pending = false; schedule() }
      }
    }
    const schedule = () => {
      if (!alive || timer) return
      timer = setTimeout(() => { timer = undefined; void read() }, 160)
    }
    schedulePreview.current = schedule
    const stop = window.codepulse.onStatus(schedule)
    schedule()
    return () => {
      alive = false
      schedulePreview.current = () => {}
      clearTimeout(timer)
      stop()
    }
  }, [active, acceptSavedDisplay])

  useEffect(() => { schedulePreview.current() }, [displayDraft])

  // Content changes have their own event stream. Agent activity must not re-read X/meme cards.
  useEffect(() => {
    if (!active) return
    let alive = true, received = false, request = 0
    let cardKey: string | undefined
    const accept = async (a: AmbientSnapshot) => {
      if (!alive) return
      setAmbientSnap(a)
      const card = a.cards[0], nextKey = JSON.stringify(card ?? null)
      if (cardKey === nextKey) return
      cardKey = nextKey
      const current = ++request
      setAmbientPreview(undefined)
      if (!card) return
      try {
        const preview = await window.codepulse.previewAmbient(card.id)
        if (alive && request === current) setAmbientPreview(preview)
      } catch { if (alive && request === current) cardKey = undefined }
    }
    const stop = window.codepulse.onAmbient(a => { received = true; void accept(a) })
    void window.codepulse.getAmbient().then(a => { if (!received) void accept(a) }).catch(() => {})
    return () => { alive = false; stop() }
  }, [active])

  useEffect(() => {
    if (!active) return
    let alive = true, request = 0, key = ''
    const accept = (snapshot: import('@codepulse/shared').AssistantSnapshot) => {
      const next = JSON.stringify([snapshot.tasks, snapshot.tasks.filter(t => t.status === 'pending' && t.dueAt !== null && t.dueAt <= Date.now()).map(t => t.id)])
      if (next === key) return
      key = next
      const current = ++request
      void window.codepulse.previewDeskTasks().then(status => {
        if (alive && current === request) setTodoPreview(status)
      }).catch(() => { if (alive && current === request) key = '' })
    }
    const stop = window.codepulse.onAssistant(accept)
    void window.codepulse.getAssistant().then(accept).catch(() => {})
    return () => { alive = false; stop() }
  }, [active])

  const planDirty = JSON.stringify(plan) !== JSON.stringify(savedPlan)
  const displayDirty =
    Boolean(displaySnap) && JSON.stringify(displayDraft) !== JSON.stringify(displaySnap?.config)
  const dirty = planDirty || displayDirty

  const changeDisplay = (patch: Partial<DeviceDisplayConfig>) => {
    setDisplayDraft((d) => ({ ...d, ...patch }))
    setPreviewFocus('work')
    setMessage('')
  }

  const setMode = (mode: InkDisplayPlan['mode']) => {
    setPlan((cur) => ({
      ...cur,
      mode,
      items: mode === 'cycle' && cur.items.length === 0 ? ['work', 'ambient'] : cur.items,
    }))
    setMessage('')
  }

  const toggleItem = (id: InkFeatureId) => {
    if (plan.mode === 'single') {
      setPlan((cur) => ({ ...cur, fixed: id }))
      setPreviewFocus(id)
    } else {
      setPlan((cur) => {
        const exists = cur.items.includes(id)
        const next = exists ? cur.items.filter((x) => x !== id) : [...cur.items, id]
        const valid = next.length > 0 ? next : [id]
        return { ...cur, items: valid }
      })
      setPreviewFocus(id)
    }
    setMessage('')
  }

  const applyAll = async () => {
    setSaving(true)
    setMessage('')
    try {
      await product.setInkPlan(plan)
      if (displayDirty) {
        const s = await window.codepulse.setDeviceDisplay(displayDraft)
        setDisplaySnap(s)
        savedDisplayRef.current = s.config
        setDisplayDraft(s.config)
      }
      if (ambientSnap) {
        const enableAmbient =
          plan.mode === 'cycle' ? plan.items.includes('ambient') : plan.fixed === 'ambient'
        await window.codepulse
          .setAmbient({
            ...ambientSnap.config,
            enabled: enableAmbient,
            displayMinutes: plan.intervalMinutes,
          })
      }
      setMessage(zh ? '已保存墨水屏配置' : 'Saved e-paper configuration')
    } catch {
      setMessage(zh ? '保存失败，请重试' : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const activePreviewKind: InkFeatureId =
    plan.mode === 'single'
      ? plan.fixed
      : plan.items.includes(previewFocus)
        ? previewFocus
        : plan.items[0] ?? 'work'

  const densitySample = useMemo(
    () =>
      previewSource === 'live' ? undefined : createDeviceDensityPreview(displayDraft, previewSource),
    [displayDraft, previewSource],
  )
  const showingSample =
    activePreviewKind === 'work' && displayDraft.mode === 'hud' && previewSource !== 'live'
  const effectiveWorkStatus =
    displayDraft.mode === 'hud' && densitySample ? densitySample : workStatus

  const statusToRender: DeviceStatusV1 | undefined =
    activePreviewKind === 'todos'
      ? todoPreview ? { ...todoPreview, display: { ...displayDraft, page: 0 } } : undefined
      : activePreviewKind === 'ambient'
      ? (ambientPreview ? { ...ambientPreview, display: { ...displayDraft, page: 0 } } : undefined) ??
        (workStatus
          ? {
              ...workStatus,
              ambient: {
                id: 'sample-ambient',
                source: 'X · @OpenAI',
                text: zh
                  ? '多媒体玩法启用后，符合筛选门槛的 X 热点与 meme 将按设定周期在墨水屏轮播展示，工作提醒始终优先。'
                  : 'Eligible X highlights and memes appear in rotation on the e-paper screen while work alerts always take priority.',
              },
            }
          : undefined)
      : effectiveWorkStatus

  const summaryText =
    plan.mode === 'single'
      ? `${zh ? '固定显示' : 'Fixed'} · ${inkFeatureLabel(plan.fixed, zh)}`
      : `${plan.items.map((i) => inkFeatureLabel(i, zh)).join(' → ')} · ${zh ? `每项 ${plan.intervalMinutes} 分钟` : `Every ${plan.intervalMinutes}m`}`

  return (
    <div className="device-workbench ink-control-workspace" data-connecting={connectOpen && active}>
      <div className="product-config-grid">
        <section className="product-preview-stage">
          <div className="product-preview-label">
            <span>{zh ? '画面预览' : 'Preview'}</span>
            {plan.mode === 'cycle' && plan.items.length > 1 ? (
              <div className="ink-preview-switcher" role="group" aria-label={zh ? '切换预览画面' : 'Switch preview'}>
                {plan.items.map(kind => <button key={kind} type="button"
                  aria-pressed={activePreviewKind === kind} onClick={() => setPreviewFocus(kind)}>
                  {kind === 'work' && zh ? '工作画面' : inkFeatureLabel(kind, zh)}
                </button>)}
              </div>
            ) : (
              <span>{summaryText}</span>
            )}
          </div>

          {statusToRender ? (
            <DeviceScreenPreview
              active={active}
              status={statusToRender}
              sample={showingSample || activePreviewKind === 'todos' || (activePreviewKind === 'ambient' && Boolean(ambientPreview))}
              fit
            />
          ) : (
            <p className="product-empty">{zh ? '正在生成墨水屏预览…' : 'Loading e-paper preview…'}</p>
          )}

          {activePreviewKind === 'work' && displayDraft.mode === 'hud' && (
            <section className="product-sample-options">
              <div className="product-sample-label">{zh ? '查看密集任务样例' : 'Dense Task Samples'}</div>
              <div className="product-sample-buttons" role="group" aria-label={zh ? '预览内容' : 'Preview source'}>
                {(['live', 3, 6, 9] as const).map((source) => (
                  <button
                    key={source}
                    type="button"
                    className="control-btn px-3 py-1.5"
                    aria-pressed={previewSource === source}
                    onClick={() => setPreviewSource(source)}
                  >
                    {source === 'live' ? (zh ? '实时任务' : 'Live') : zh ? `${source} 个任务样例` : `${source} tasks`}
                  </button>
                ))}
              </div>
              {showingSample && (
                <p className="product-caption" role="status">
                  {zh
                    ? '示例仅用于检查长标题与密集布局，不会发送到设备。切回实时任务后可应用配置。'
                    : 'Samples are for checking dense layouts only. Switch back to Live before applying.'}
                </p>
              )}
            </section>
          )}
        </section>

        <aside className="product-config ink-config">
          <div className="product-config-heading">
            <h2>{zh ? '更改配置' : 'Configuration'}</h2>
            <small>{dirty ? (zh ? '待应用' : 'Not applied') : zh ? '已应用' : 'Applied'}</small>
          </div>

          <div className="product-config-scroll">
          <h3>{zh ? '显示方式' : 'Display Mode'}</h3>
          <div className="product-segments">
            <button
              type="button"
              aria-pressed={plan.mode === 'single'}
              onClick={() => setMode('single')}
            >
              {zh ? '固定显示' : 'Fixed'}
            </button>
            <button
              type="button"
              aria-pressed={plan.mode === 'cycle'}
              onClick={() => setMode('cycle')}
            >
              {zh ? '轮播显示' : 'Cycle'}
            </button>
          </div>

          <h3>{plan.mode === 'cycle' ? (zh ? '轮播内容' : 'Cycle Content') : zh ? '常驻内容' : 'Fixed Content'}</h3>

          <div
            className={`product-feature-option ${
              (plan.mode === 'single' ? plan.fixed === 'work' : plan.items.includes('work'))
                ? 'is-selected'
                : ''
            }`}
          >
            <label className="product-feature-main">
              <input
                type={plan.mode === 'cycle' ? 'checkbox' : 'radio'}
                name="ink-content"
                checked={plan.mode === 'single' ? plan.fixed === 'work' : plan.items.includes('work')}
                onChange={() => toggleItem('work')}
              />
              <span>
                <strong>{zh ? '工作' : 'Work'}</strong>
                <small>{zh ? '会话状态与实时余量' : 'Sessions and real-time allowances'}</small>
              </span>
            </label>
          </div>

          <div
            className={`product-feature-option ${
              (plan.mode === 'single' ? plan.fixed === 'ambient' : plan.items.includes('ambient'))
                ? 'is-selected'
                : ''
            }`}
          >
            <label className="product-feature-main">
              <input
                type={plan.mode === 'cycle' ? 'checkbox' : 'radio'}
                name="ink-content"
                checked={
                  plan.mode === 'single' ? plan.fixed === 'ambient' : plan.items.includes('ambient')
                }
                onChange={() => toggleItem('ambient')}
              />
              <span>
                <strong>{zh ? '多媒体玩法' : 'Multimedia'}</strong>
                <small>{zh ? 'X 热点与 meme' : 'X highlights and memes'}</small>
              </span>
            </label>
            <button
              type="button"
              className="product-feature-link"
              onClick={() => void product.navigate('ambient')}
            >
              {zh ? '配置' : 'Configure'}
            </button>
          </div>

          <div className={`product-feature-option ${(plan.mode === 'single' ? plan.fixed === 'todos' : plan.items.includes('todos')) ? 'is-selected' : ''}`}>
            <label className="product-feature-main">
              <input type={plan.mode === 'cycle' ? 'checkbox' : 'radio'} name="ink-content"
                checked={plan.mode === 'single' ? plan.fixed === 'todos' : plan.items.includes('todos')}
                onChange={() => toggleItem('todos')}/>
              <span><strong>{zh ? '待办与提醒' : 'Tasks & reminders'}</strong><small>{zh ? '本地事项与到期时间' : 'Local tasks and reminder times'}</small></span>
            </label>
            <button type="button" className="product-feature-link" onClick={() => void product.navigate('assistant')}>{zh ? '管理' : 'Manage'}</button>
          </div>

          <div className="product-feature-option is-disabled">
            <label className="product-feature-main">
              <input type="checkbox" disabled />
              <span>
                <strong>{zh ? '用量统计' : 'Usage'}</strong>
                <small>{zh ? '历史 Token 与调用统计' : 'Historical tokens and requests'}</small>
              </span>
            </label>
            <em className="product-feature-badge">{zh ? '暂不支持' : 'Unsupported'}</em>
          </div>

          {plan.mode === 'cycle' && (
            <label className="product-cycle-row">
              <span>{zh ? '每项停留' : 'Interval'}</span>
              <select
                value={plan.intervalMinutes}
                onChange={(e) => {
                  setPlan((cur) => ({
                    ...cur,
                    intervalMinutes: Number(e.target.value) as InkCycleInterval,
                  }))
                  setMessage('')
                }}
              >
                <option value={10}>{zh ? '10 分钟' : '10 min'}</option>
                <option value={15}>{zh ? '15 分钟' : '15 min'}</option>
                <option value={30}>{zh ? '30 分钟' : '30 min'}</option>
              </select>
            </label>
          )}

          <h3>{zh ? '工作画面细项' : 'Work Screen Options'}</h3>
          <div className="product-segments">
            {(['hud', 'usage'] as const).map((mode) => (
              <button
                type="button"
                key={mode}
                aria-pressed={displayDraft.mode === mode}
                onClick={() => changeDisplay({ mode })}
              >
                {mode === 'hud' ? (zh ? '工作状态' : 'Work Status') : zh ? '用量看板' : 'Quota Board'}
              </button>
            ))}
          </div>

          <details className="ink-work-options">
          <summary>{zh ? '显示细项' : 'Display details'}</summary>
          <div className="hud-tools-grid mt-2">
            {DISPLAY_AGENT_TYPES.map((type) => (
              <label key={type} className="hud-inline-check">
                <input
                  type="checkbox"
                  checked={displayDraft.agents.includes(type)}
                  onChange={(e) =>
                    changeDisplay({
                      agents: DISPLAY_AGENT_TYPES.filter((t) =>
                        t === type ? e.target.checked : displayDraft.agents.includes(t),
                      ),
                      page: 0,
                    })
                  }
                />
                <span>{INK_AGENT_NAMES[type]}</span>
              </label>
            ))}
          </div>

          <div className="mt-2 grid gap-1">
            <label className="hud-inline-check">
              <input
                type="checkbox"
                disabled={displayDraft.mode === 'usage'}
                checked={displayDraft.showQuota}
                onChange={(e) => changeDisplay({ showQuota: e.target.checked })}
              />
              <span>{zh ? '工作画面显示额度' : 'Show quota in work view'}</span>
            </label>
            <label className="hud-inline-check">
              <input
                type="checkbox"
                checked={displayDraft.showEnvironment}
                onChange={(e) => changeDisplay({ showEnvironment: e.target.checked })}
              />
              <span>{zh ? '显示温度与湿度' : 'Show temperature & humidity'}</span>
            </label>
          </div>

          <label><input type="checkbox" checked={Boolean(displayDraft.inverted)} onChange={(e) => changeDisplay({ inverted: e.target.checked })} /> 黑底白字（固件 0.0.24 起支持）</label>
              <label className="product-cycle-row">
            <span>{zh ? '额度口径' : 'Quota Metric'}</span>
            <select
              value={displayDraft.metric}
              onChange={(e) =>
                changeDisplay({ metric: e.target.value as DeviceDisplayConfig['metric'] })
              }
            >
              <option value="remaining">{zh ? '剩余' : 'Remaining'}</option>
              <option value="used">{zh ? '已用' : 'Used'}</option>
            </select>
          </label>

          </details>
          </div>
          <footer className="product-config-actions">
          <button
            type="button"
            className="product-button primary"
            disabled={saving || !product.ready || !dirty || showingSample}
            onClick={() => void applyAll()}
          >
            {saving ? (zh ? '保存中…' : 'Saving…') : zh ? '立即应用' : 'Apply now'}
          </button>
          {message && (
            <p className="product-caption" role="status">
              {message}
            </p>
          )}
          </footer>
        </aside>
      </div>

      {connectOpen && active && (
        <div className="product-device-connection">
          <DeviceProvisioningPanel copy={deviceCopy} />
        </div>
      )}
    </div>
  )
}

export function ProductControl({
  product,
  locale,
  deviceCopy,
  desktopPreview,
  usagePreview,
  active,
}: {
  product: ProductNavigation
  locale: Locale
  deviceCopy: DeviceProvisioningCopy
  snapshot?: StatusSnapshot
  desktopPreview: ReactNode
  usagePreview: ReactNode
  active: boolean
}): JSX.Element {
  const zh = locale === 'zh',
    target = product.target
  // Retain mounted desktop panels/drafts without reconciling their live trees while hidden.
  const desktopContent = useRef({ work: desktopPreview, usage: usagePreview })
  if (active && target === 'desktop') desktopContent.current = { work: desktopPreview, usage: usagePreview }
  const [visited, setVisited] = useState(new Set([target]))
  const [connectOpen, setConnectOpen] = useState(false)
  const [layout, setLayout] = useState<DesktopLayout>(product.shell.desktopLayout)
  const savedLayout = useRef(product.shell.desktopLayout)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setVisited((old) => old.has(target) ? old : new Set([...old, target]))
  }, [target])

  useEffect(() => {
    const previous = savedLayout.current
    setLayout((draft) => (draft === previous ? product.shell.desktopLayout : draft))
    savedLayout.current = product.shell.desktopLayout
  }, [product.shell.desktopLayout])

  const apply = async () => {
    setSaving(true)
    try {
      await product.setLayout(layout)
    } finally {
      setSaving(false)
    }
  }

  const names = {
    work: zh ? '工作' : 'Work',
    usage: zh ? '用量统计' : 'Usage',
    board: zh ? '工作 + 用量统计 · 平铺' : 'Work + Usage · Board',
  }

  const inkPlan = product.shell.inkPlan ?? DEFAULT_INK_PLAN
  const inkSummary =
    inkPlan.mode === 'single'
      ? `${inkFeatureLabel(inkPlan.fixed, zh)} · ${zh ? '固定显示' : 'Fixed'}`
      : `${inkPlan.items.map((i) => inkFeatureLabel(i, zh)).join(' / ')} · ${zh ? '轮播' : 'Cycle'}`

  const hudLayoutName =
    product.shell.hudSettings?.projectLayout === 'grid'
      ? zh
        ? '工作 · 紧凑矩阵'
        : 'Work · Grid'
      : zh
        ? '工作 · 单列排序'
        : 'Work · List'

  return (
    <div className="product-scroll product-control">
      <header className="workspace-heading">
        <div>
          <h1>{zh ? '控制' : 'Control'}</h1>
          <p>{zh ? '选择展示端，实时查看工作状态并更改配置。' : 'Select a presentation, view live status and configure it.'}</p>
        </div>
        <div className="product-focus-entry">
          <button
            type="button"
            className="product-button primary"
            disabled={!product.ready}
            onClick={() => void product.setFocus(true)}
          >
            <ProductIcon name="focus" />
            {zh ? '进入专注模式' : 'Enter focus mode'}
          </button>
          <small>{zh ? '只保留会话与账户余量' : 'Only sessions and account allowances'}</small>
        </div>
      </header>

      <div className="product-control-group" data-target={target}>
        <div className="product-endpoints" role="group" aria-label={zh ? '选择展示端' : 'Select presentation'}>
          {(['desktop', 'hud', 'ink'] as const).map((t) => (
            <article key={t} className={`product-endpoint ${target === t ? 'is-current' : ''}`}>
              <button
                id={`endpoint-${t}`}
                type="button"
                className="product-endpoint-select"
                aria-pressed={target === t}
                aria-controls="product-control-detail"
                onClick={() => void product.selectTarget(t)}
              >
                <span className="product-endpoint-head">
                  <strong>
                    <ProductIcon name={t} />
                    {TARGET_NAMES[t][zh ? 0 : 1]}
                  </strong>
                  <small className="product-endpoint-status">
                    {t === 'desktop'
                      ? zh
                        ? '已打开'
                        : 'Open'
                      : t === 'hud'
                        ? product.shell.hudVisible
                          ? zh
                            ? '已打开'
                            : 'Open'
                          : zh
                            ? '已收起'
                            : 'Hidden'
                        : zh
                          ? '设备显示'
                          : 'Device'}
                  </small>
                </span>
                <span className="product-endpoint-meta">
                  <span className="product-endpoint-content">
                    {t === 'desktop'
                      ? names[product.shell.desktopLayout]
                      : t === 'hud'
                        ? hudLayoutName
                        : inkSummary}
                  </span>
                  <small className="product-endpoint-description">
                    {t === 'desktop'
                      ? zh
                        ? '主窗口'
                        : 'Main window'
                      : t === 'hud'
                        ? zh
                          ? '独立桌面浮窗'
                          : 'Companion window'
                        : zh
                          ? '400×300 墨水屏'
                          : '400×300 E-paper'}
                  </small>
                </span>
              </button>
              <div className="product-endpoint-actions">
                <button
                  type="button"
                  className="product-button endpoint-action-btn"
                  disabled={t === 'hud' && !product.shell.hudAvailable}
                  onClick={() => {
                    if (t === 'hud') void product.setHudVisible(!product.shell.hudVisible)
                    else if (t === 'desktop') void product.setFocus(true)
                    else
                      void product.selectTarget('ink').then((ok) => {
                        if (ok) setConnectOpen((v) => !v)
                      })
                  }}
                >
                  {t === 'desktop'
                    ? zh
                      ? '专注查看'
                      : 'Focus View'
                    : t === 'hud'
                      ? product.shell.hudVisible
                        ? zh
                          ? '收起 HUD'
                          : 'Hide HUD'
                        : zh
                          ? '开启 HUD'
                          : 'Open HUD'
                      : connectOpen && target === 'ink'
                        ? zh
                          ? '收起连接'
                          : 'Hide Connect'
                        : zh
                          ? '连接设备'
                          : 'Connect Device'}
                </button>
              </div>
            </article>
          ))}
        </div>

        <section
          className="product-control-detail"
          id="product-control-detail"
          aria-labelledby={`endpoint-${target}`}
        >
          {(target === 'desktop' || visited.has('desktop')) && (
            <div hidden={target !== 'desktop'} className="product-config-grid">
              <section className="product-preview-stage">
                <div className="product-preview-label">
                  <span>{zh ? '桌面端实时工作台' : 'Live Desktop Workspace'}</span>
                  <span>{names[layout]}</span>
                </div>
                <div className={`product-desktop-preview ${layout === 'board' ? 'is-board' : ''}`}>
                  {layout !== 'usage' && (
                    <div className="product-console-live-stage">{desktopContent.current.work}</div>
                  )}
                  {layout !== 'work' && (
                    <div className="product-usage-preview">{desktopContent.current.usage}</div>
                  )}
                </div>
              </section>

              <aside className="product-config">
                <div className="product-config-heading">
                  <h2>{zh ? '更改配置' : 'Configuration'}</h2>
                  <small>
                    {layout === product.shell.desktopLayout
                      ? zh
                        ? '已应用'
                        : 'Applied'
                      : zh
                        ? '待应用'
                        : 'Not applied'}
                  </small>
                </div>

                <h3>{zh ? '显示方式' : 'Layout'}</h3>
                <div className="product-segments">
                  <button
                    type="button"
                    aria-pressed={layout !== 'board'}
                    onClick={() => setLayout(layout === 'board' ? 'work' : layout)}
                  >
                    {zh ? '单个功能' : 'Single'}
                  </button>
                  <button
                    type="button"
                    aria-pressed={layout === 'board'}
                    onClick={() => setLayout('board')}
                  >
                    {zh ? '功能平铺' : 'Board'}
                  </button>
                </div>

                <h3>{zh ? '显示内容' : 'Content'}</h3>
                {(['work', 'usage'] as const).map((item) => (
                  <div
                    className={`product-feature-option ${
                      layout === 'board' || layout === item ? 'is-selected' : ''
                    }`}
                    key={item}
                  >
                    <label className="product-feature-main">
                      <input
                        type={layout === 'board' ? 'checkbox' : 'radio'}
                        name="desktop-content"
                        checked={layout === 'board' || layout === item}
                        onChange={() =>
                          setLayout(
                            layout === 'board' ? (item === 'work' ? 'usage' : 'work') : item,
                          )
                        }
                      />
                      <span>
                        <strong>{names[item]}</strong>
                        <small>
                          {item === 'work'
                            ? zh
                              ? '会话状态与实时余量'
                              : 'Sessions and allowances'
                            : zh
                              ? '历史 Token 与调用统计'
                              : 'Historical tokens and requests'}
                        </small>
                      </span>
                    </label>
                    <button
                      type="button"
                      className="product-feature-link"
                      onClick={() => {
                        if (item === 'work') {
                          void product.setFocus(true)
                        } else {
                          void product.navigate('usage')
                        }
                      }}
                    >
                      {item === 'work' ? (zh ? '专注' : 'Focus') : zh ? '查看' : 'View'}
                    </button>
                  </div>
                ))}

                <div className="product-feature-option is-disabled">
                  <label className="product-feature-main">
                    <input type="checkbox" disabled />
                    <span>
                      <strong>{zh ? '多媒体玩法' : 'Multimedia'}</strong>
                      <small>{zh ? '桌面端暂未开放' : 'Not yet available on desktop'}</small>
                    </span>
                  </label>
                  <em className="product-feature-badge">{zh ? '暂不支持' : 'Unsupported'}</em>
                </div>

                <button
                  type="button"
                  className="product-button primary"
                  disabled={saving || !product.ready || layout === product.shell.desktopLayout}
                  onClick={() => void apply()}
                >
                  {saving ? (zh ? '保存中…' : 'Saving…') : zh ? '立即应用' : 'Apply now'}
                </button>
              </aside>
            </div>
          )}

          {(target === 'hud' || visited.has('hud')) && (
            <div hidden={target !== 'hud'} className="product-control-surface">
              <HudWorkspace product={product} locale={locale} active={active && target === 'hud'} />
            </div>
          )}

          {(target === 'ink' || visited.has('ink')) && (
            <div hidden={target !== 'ink'} className="product-control-surface">
              <InkControlWorkspace
                active={active && target === 'ink'}
                locale={locale}
                product={product}
                deviceCopy={deviceCopy}
                connectOpen={connectOpen}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
