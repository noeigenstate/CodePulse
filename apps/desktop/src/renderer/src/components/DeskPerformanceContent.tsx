import { useEffect, useState } from 'react'
import {
  DEFAULT_DEVICE_DISPLAY,
  PERFORMANCE_LAYOUTS,
  deskPerformancePlayback,
  normalizePerformanceOptions,
  type DeskPerformancePlayback,
  type InkPerformanceOptions,
  type DeviceDisplayConfig,
  type InkDisplayPlan,
} from '@codepulse/shared'
import { usePerformancePreview } from '../lib/usePerformancePreview.js'
import type { Locale } from '../lib/i18n.js'
import { DeviceScreenPreview } from './DeviceScreenPreview.js'

export function DeskPerformanceContent({
  active,
  display,
  locale,
}: {
  active: boolean
  display?: DeviceDisplayConfig
  locale: Locale
}) {
  const zh = locale === 'zh'
  const [plan, setPlan] = useState<InkDisplayPlan>()
  const [patch, setPatch] = useState<Partial<InkPerformanceOptions>>({})
  const [playbackDraft, setPlayback] = useState<DeskPerformancePlayback>()
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<'saved' | 'failed' | 'load-error'>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true,
      received = false
    const stop = window.codepulse.onShell((value) => {
      received = true
      if (current) setPlan(value.inkPlan)
    })
    void window.codepulse
      .getShell()
      .then((value) => {
        if (current && !received) setPlan(value.inkPlan)
      })
      .catch(() => {
        if (current && !received) setFeedback('load-error')
      })
    return () => {
      current = false
      stop()
    }
  }, [attempt])
  const saved = normalizePerformanceOptions(plan?.performance)
  const options = { ...saved, ...patch }
  const savedPlayback = plan ? deskPerformancePlayback(plan) : 'preview'
  const playback = playbackDraft ?? savedPlayback
  const changedOptions = JSON.stringify(options) !== JSON.stringify(saved)
  const dirty = changedOptions || playback !== savedPlayback
  const rotationPaused =
    playback === 'cycle' &&
    savedPlayback === 'cycle' &&
    (plan?.mode === 'single' || plan?.deskContentPaused === true)
  const resume = rotationPaused && !dirty
  const preview = usePerformancePreview(
    active && !!plan,
    options,
    display ?? DEFAULT_DEVICE_DISPLAY,
  )
  const change = (value: Partial<InkPerformanceOptions>) => {
    setPatch((previous) => ({ ...previous, ...value }))
    setFeedback(undefined)
  }
  async function apply() {
    if (!plan || saving || (!dirty && !resume)) return
    setSaving(true)
    try {
      const result = await window.codepulse.setDeskPerformance({
        ...(changedOptions ? { options: patch } : {}),
        ...(playback !== savedPlayback || resume ? { playback } : {}),
      })
      setPlan(result.inkPlan)
      setPatch({})
      setPlayback(undefined)
      setFeedback('saved')
    } catch {
      setFeedback('failed')
    } finally {
      setSaving(false)
    }
  }
  const labels = zh
    ? ['逐核明细', '均衡总览', 'GPU 优先']
    : ['Core detail', 'Overview', 'GPU first']
  const adapters = preview.result?.gpus ?? []
  const pages = preview.result?.pages ?? 0
  return (
    <div className="ambient-inner" data-desk-performance>
      <fieldset
        className="ambient-items-col ambient-fieldset desk-performance-fields"
        disabled={!plan || saving}
      >
        <div
          className="ambient-items"
          role="group"
          aria-label={zh ? '性能布局' : 'Performance layout'}
        >
          {PERFORMANCE_LAYOUTS.map((layout, i) => (
            <button
              type="button"
              key={layout}
              className="ambient-item"
              aria-pressed={options.layout === layout}
              onClick={() => change({ layout })}
            >
              {labels[i]}
            </button>
          ))}
        </div>
        {(adapters.length > 0 || options.gpu !== 'auto') && (
          <label className="page-field">
            {zh ? '显卡' : 'GPU'}
            <select
              data-performance-gpu
              value={options.gpu}
              onChange={(e) => change({ gpu: e.target.value })}
            >
              <option value="auto">{zh ? '自动选择' : 'Automatic'}</option>
              {options.gpu !== 'auto' && !adapters.some((g) => g.id === options.gpu) && (
                <option value={options.gpu}>{options.gpu}</option>
              )}
              {adapters.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} · {g.id}
                </option>
              ))}
            </select>
          </label>
        )}
        {pages > 1 && (
          <label className="page-field">
            {zh ? '逻辑核分组' : 'Logical CPU group'}
            <select
              data-performance-page
              value={Math.min(options.page, pages - 1)}
              onChange={(e) => change({ page: Number(e.target.value) })}
            >
              {Array.from({ length: pages }, (_, i) => (
                <option key={i} value={i}>
                  {i + 1} / {pages}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="page-field">
          {zh ? '墨水屏显示方式' : 'E-paper playback'}
          <select
            data-performance-playback
            value={playback}
            onChange={(e) => {
              setPlayback(e.target.value as DeskPerformancePlayback)
              setFeedback(undefined)
            }}
          >
            <option value="preview">{zh ? '仅预览' : 'Preview only'}</option>
            <option value="cycle">{zh ? '加入轮播' : 'Include in rotation'}</option>
            <option value="fixed">{zh ? '固定显示' : 'Pin to e-paper'}</option>
          </select>
        </label>
        <button
          className="product-button primary"
          type="button"
          disabled={(!dirty && !resume) || saving}
          onClick={() => void apply()}
        >
          {saving
            ? zh
              ? '保存中…'
              : 'Saving…'
            : resume
              ? zh
                ? '恢复轮播'
                : 'Resume rotation'
              : zh
                ? '应用'
                : 'Apply'}
        </button>
        {rotationPaused && (
          <p className="product-caption">
            {zh
              ? '已保留轮播设置，目前节目单暂停展示此项。'
              : 'This item is saved for rotation. The current playlist has it paused.'}
          </p>
        )}
        <p className="ambient-message" role="status">
          {feedback === 'failed'
            ? zh
              ? '保存失败，可以重试。'
              : 'Save failed. Try again.'
            : feedback === 'saved' && !dirty
              ? zh
                ? '已保存'
                : 'Saved'
              : ''}
        </p>
      </fieldset>
      <div className="ambient-stage-col">
        <section className="ambient-stage">
          {preview.result?.status ? (
            <DeviceScreenPreview
              status={preview.result.status}
              active={active}
              fit
              compact
              cornerTag={zh ? '实时预览' : 'Live preview'}
            />
          ) : (
            <p className="ambient-empty" role="status">
              {feedback === 'load-error' && !plan ? (
                <button
                  className="product-button"
                  onClick={() => {
                    setFeedback(undefined)
                    setAttempt((n) => n + 1)
                  }}
                >
                  {zh ? '重新读取配置' : 'Retry loading settings'}
                </button>
              ) : preview.error ? (
                zh ? (
                  '性能数据暂不可用'
                ) : (
                  'Performance data unavailable'
                )
              ) : zh ? (
                '正在读取本机性能…'
              ) : (
                'Reading PC performance…'
              )}
            </p>
          )}
          <p className="product-caption">
            {zh
              ? '查看时每 30 秒采样，墨水屏常规更新至少间隔 1 分钟。'
              : 'Samples every 30 seconds while viewed. The panel updates at most once a minute.'}
          </p>
        </section>
      </div>
    </div>
  )
}
