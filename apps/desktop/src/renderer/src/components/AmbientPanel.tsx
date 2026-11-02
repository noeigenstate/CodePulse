import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_AMBIENT,
  petMoodLabel,
  normalizeAmbient,
  petProfile,
  type AmbientCard,
  type AmbientConfig,
  type AmbientSnapshot,
  type CalendarNextHoliday,
  type DeviceStatusV1,
} from '@codepulse/shared'
import { DeviceScreenPreview } from './DeviceScreenPreview.js'
import { PageHeader } from './PageHeader.js'
import { planesToRgba } from '../device-preview/renderer.mjs'
import './ambient-panel.css'
import { useScreenTarget } from '../lib/useScreenTarget.js'
import { useInkStatus } from '../lib/useInkStatus.js'
import { inkPlanChip, showingText } from '../lib/inkStatusText.js'

/** Tail of the calendar info line: the break going on, or how far away the next one is. */
function nextHolidayText(next: CalendarNextHoliday | undefined): string {
  if (!next) return ' · 暂无下一个假日数据'
  return next.ongoing ? ` · ${next.name}假期中` : ` · 距 ${next.name} 还有 ${next.inDays} 天`
}

const PET_CROP = { x: 4, y: 8, w: 232, h: 196 }
/**
 * The picture-area crop of a 400 x 300 frame with each ink pixel (not white) also painted on its
 * paper neighbours. Red goes first so black wins where the two meet, as on the screen.
 */
function thickenInk(frame: ImageData, crop: typeof PET_CROP): ImageData {
  const left = 8 + crop.x,
    top = 60 + crop.y
  const source = new Uint8ClampedArray(crop.w * crop.h * 4)
  for (let y = 0; y < crop.h; y++)
    source.set(
      frame.data.subarray(((top + y) * 400 + left) * 4, ((top + y) * 400 + left + crop.w) * 4),
      y * crop.w * 4,
    )
  const out = new Uint8ClampedArray(source)
  const isInk = (i: number) => source[i] !== 255 || source[i + 1] !== 255 || source[i + 2] !== 255
  const isBlack = (i: number) => source[i] === 0 && source[i + 1] === 0 && source[i + 2] === 0
  for (const black of [false, true])
    for (let y = 0; y < crop.h; y++)
      for (let x = 0; x < crop.w; x++) {
        const i = (y * crop.w + x) * 4
        if (!isInk(i) || isBlack(i) !== black) continue
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx,
              ny = y + dy
            if (nx < 0 || ny < 0 || nx >= crop.w || ny >= crop.h) continue
            const j = (ny * crop.w + nx) * 4
            if (isInk(j)) continue
            if (!black && (out[j] !== 255 || out[j + 1] !== 255 || out[j + 2] !== 255)) continue
            out.set(source.subarray(i, i + 4), j)
          }
      }
  return new ImageData(out, crop.w, crop.h)
}
/** Thumbnail width in CSS px; the canvas itself is sized in device pixels so edges stay smooth. */
const PET_THUMB_W = 64
const PET_THUMB_H = (PET_THUMB_W * PET_CROP.h) / PET_CROP.w
/**
 * Small look at a pet card's bitmap. It lays the card into the same two planes the device uses
 * and paints them with the shared preview colours, so black wins over red exactly as on the screen.
 * The crop is cut at native size, every ink pixel is grown by one pixel (black over red, never over
 * paper that another colour owns), and only then is it scaled with smoothing to the target size:
 * the 2 to 3 px outlines would otherwise average with the paper and break into dashes.
 */
function PetThumb({ card }: { card: AmbientCard }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [ratio, setRatio] = useState(() => window.devicePixelRatio || 1)
  useEffect(() => {
    const update = () => setRatio(window.devicePixelRatio || 1)
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  useEffect(() => {
    const target = canvas.current
    const context = target?.getContext('2d')
    if (!target || !context || !card.imageHex) return
    const black = new Uint8Array(15000).fill(0xff),
      red = new Uint8Array(15000).fill(0xff)
    // Picture area origin on the 400 x 300 screen is (8, 60); a set bit is ink, a cleared bit is paint.
    const lay = (plane: Uint8Array, hex: string, width: number, left: number, top: number) => {
      for (let i = 0; i < hex.length / 2; i++) {
        const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
        if (!byte) continue
        for (let bit = 0; bit < 8; bit++)
          if (byte & (0x80 >> bit)) {
            const n = i * 8 + bit,
              pixel = (60 + top + Math.floor(n / width)) * 400 + 8 + left + (n % width)
            plane[pixel >> 3] = plane[pixel >> 3]! & ~(0x80 >> (pixel & 7))
          }
      }
    }
    lay(black, card.imageHex, 384, 0, 0)
    if (card.red) lay(red, card.red.hex, card.red.w, card.red.x, card.red.y)
    const image = new ImageData(new Uint8ClampedArray(planesToRgba(black, red)), 400, 300)
    // Native-size crop on an offscreen canvas, so smoothing never blends in the rest of the screen.
    const crop = document.createElement('canvas')
    crop.width = PET_CROP.w
    crop.height = PET_CROP.h
    crop.getContext('2d')?.putImageData(thickenInk(image, PET_CROP), 0, 0)
    target.width = Math.round(PET_THUMB_W * ratio)
    target.height = Math.round(PET_THUMB_H * ratio)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.fillStyle = '#fff'
    context.fillRect(0, 0, target.width, target.height)
    context.drawImage(crop, 0, 0, target.width, target.height)
  }, [card.imageHex, card.red, ratio])
  return (
    <canvas ref={canvas} style={{ width: PET_THUMB_W, height: PET_THUMB_H }} aria-hidden="true" />
  )
}

type Category = 'concept' | 'prompt' | 'pet' | 'calendar' | 'news' | 'social' | 'local'
/** Tab names are the rule names, so a tab and its rule row always read the same. */
const CATEGORIES: { id: Category; label: string; rule: string }[] = [
  { id: 'concept', label: '概念卡', rule: '经济学 / 哲学 / 物理学，每天最多出现一次' },
  { id: 'prompt', label: '思考实验', rule: '一分钟读完的思考实验，离线可用' },
  { id: 'pet', label: '像素宠物', rule: '按当前心情出场，同一形象同一心情每天最多一次' },
  { id: 'calendar', label: '日历', rule: '农历与节假日，每天最多出现一次。假日数据：内置 2025–2026，联网自动更新。' },
  { id: 'news', label: '科技热议', rule: '来自 Hacker News 近 24 小时超过 100 赞的标题，保留原文' },
  { id: 'social', label: 'X 与 meme', rule: '指定账号的热门原帖，以及少量高热度 meme 图片' },
  { id: 'local', label: '我的图片与便签', rule: '拖进页面的图片与便签，只在手动展示时出现' },
]
const RULE_FLAG: Partial<Record<Category, 'conceptsEnabled' | 'promptsEnabled' | 'petEnabled' | 'calendarEnabled' | 'newsEnabled'>> = {
  concept: 'conceptsEnabled',
  prompt: 'promptsEnabled',
  pet: 'petEnabled',
  calendar: 'calendarEnabled',
  news: 'newsEnabled',
}
const SAVE_DELAY_MS = 400

type NumberField =
  | 'minLikes'
  | 'memeMinUps'
  | 'pollMinutes'
  | 'gapMinutes'
  | 'dailyLimit'
  | 'dailyRequestLimit'
  | 'quietStart'
  | 'quietEnd'

/** A number that is only committed on blur or Enter, so typing "30" never saves "3" first. */
function NumberRule({ label, value, min, max, disabled, onCommit }: {
  label: string
  value: number
  min: number
  max: number
  disabled?: boolean
  onCommit: (value: number) => void
}): JSX.Element {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const parsed = Number(text)
    const next = Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : value
    setText(String(next))
    if (next !== value) onCommit(next)
  }
  return (
    <label className="page-field">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
    </label>
  )
}

export function AmbientPanel({
  active = true,
  product,
  locale = 'zh',
}: {
  active?: boolean
  /** ia-refactor contract: shell state (applied playlist) and navigation to 控制 › 节目单. */
  product?: import('./ProductFrame.js').ProductNavigation
  locale?: import('../lib/i18n.js').Locale
}): JSX.Element {
  const { target, error: targetError } = useScreenTarget(active)
  const ink = useInkStatus()
  const online = ink?.connection === 'connected'
  const [snapshot, setSnapshot] = useState<AmbientSnapshot>()
  const [draft, setDraft] = useState<AmbientConfig>({ ...DEFAULT_AMBIENT })
  const [key, setKey] = useState('')
  const [category, setCategory] = useState<Category>('concept')
  const [note, setNote] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [messageScope, setMessageScope] = useState<'content' | 'settings'>('content')
  const [preview, setPreview] = useState<DeviceStatusV1>()
  const [savedFlash, setSavedFlash] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const savedConfig = useRef<AmbientConfig>()
  const draftRef = useRef(draft)
  draftRef.current = draft
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const flashTimer = useRef<ReturnType<typeof setTimeout>>()
  const unsaved = useRef(false)
  const saveSeq = useRef(0)
  useEffect(() => {
    let alive = true,
      received = false
    void window.codepulse
      .getAmbient()
      .then((s) => {
        if (alive && !received) {
          setSnapshot(s)
          // A host that predates a setting (or sends an odd value) must not break the page.
          savedConfig.current = normalizeAmbient(s.config)
          setDraft(savedConfig.current)
        }
      })
      .catch(() => {
        if (alive) setMessage('当前桌面服务尚未加载桌边内容，请重新启动统一应用。')
      })
    const stop = window.codepulse.onAmbient((s) => {
      received = true
      if (!alive) return
      setSnapshot(s)
      const incoming = normalizeAmbient(s.config)
      if (JSON.stringify(savedConfig.current) !== JSON.stringify(incoming)) {
        savedConfig.current = incoming
        // Never overwrite what the user is typing; the pending save carries it.
        if (!unsaved.current) setDraft(incoming)
      }
    })
    return () => {
      alive = false
      stop()
      clearTimeout(saveTimer.current)
      clearTimeout(flashTimer.current)
    }
  }, [])

  /**
   * Rules save by themselves. `enabled` and `displayMinutes` belong to the playlist in 控制 and are
   * never taken from the draft: the last saved values go back with every write.
   */
  async function persist(next: AmbientConfig) {
    const seq = ++saveSeq.current
    const base = savedConfig.current
    try {
      const state = await window.codepulse.setAmbient(
        base ? { ...next, enabled: base.enabled, displayMinutes: base.displayMinutes } : next,
      )
      savedConfig.current = normalizeAmbient(state.config)
      setSnapshot(state)
      if (seq === saveSeq.current) unsaved.current = false
      setSaveFailed(false)
      setSavedFlash(true)
      clearTimeout(flashTimer.current)
      flashTimer.current = setTimeout(() => setSavedFlash(false), 1800)
    } catch {
      if (seq === saveSeq.current) unsaved.current = false
      setSavedFlash(false)
      setSaveFailed(true)
    }
  }
  const edit = <K extends keyof AmbientConfig>(name: K, value: AmbientConfig[K], delay = 0) => {
    const next = { ...draftRef.current, [name]: value }
    draftRef.current = next
    setDraft(next)
    unsaved.current = true
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void persist(draftRef.current), delay)
  }
  async function action(
    run: () => Promise<AmbientSnapshot>,
    success = '',
    scope: 'content' | 'settings' = 'content',
  ) {
    setMessageScope(scope)
    setBusy(true)
    setMessage('')
    try {
      const state = await run()
      setSnapshot(state)
      setMessage(success)
    } catch (error) {
      const detail = error instanceof Error ? error.message.split('Error: ').pop()! : ''
      setMessage(
        /^(先处理 Agent|内容已过期|请选择|请填写|图片|仅支持)/.test(detail)
          ? detail
          : '操作未完成，请检查来源连接或系统加密存储。',
      )
    } finally {
      setBusy(false)
    }
  }
  async function showPreview(card: AmbientCard) {
    setMessageScope('content')
    setMessage('')
    setBusy(true)
    try {
      setSelectedId(card.id)
      setPreview(await window.codepulse.previewAmbient(card.id))
    } catch {
      setMessage('这条内容已过期，请刷新候选。')
    } finally {
      setBusy(false)
    }
  }
  async function importFile(file?: File) {
    if (!file || busy) return
    setMessageScope('content')
    setBusy(true)
    setMessage('')
    try {
      if (file.size > 8000000 || !/\.(png|jpe?g)$/i.test(file.name))
        throw new Error('请选择 8 MB 内的 PNG / JPEG 图片')
      const card = await window.codepulse.importAmbientImage(
        new Uint8Array(await file.arrayBuffer()),
        file.name,
      )
      setCategory('local')
      setSnapshot(await window.codepulse.getAmbient())
      setSelectedId(card.id)
      setPreview(await window.codepulse.previewAmbient(card.id))
      if (!online) {
        setMessage('图片已保存，可以先预览。连接设备后可临时展示。')
      } else {
        try {
          setSnapshot(await window.codepulse.showAmbient(card.id))
          setPreview(undefined)
          setMessage('图片已临时展示到墨水屏，10 分钟后自动回到节目单。')
        } catch (error) {
          const detail = error instanceof Error ? error.message.split('Error: ').pop()! : ''
          setMessage(
            /^先处理 Agent/.test(detail)
              ? `图片已准备好。${detail}`
              : '图片已保存，但展示未完成，请点击“临时展示到墨水屏”重试。',
          )
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message.split('Error: ').pop()! : ''
      setMessage(
        /^(请选择|图片|仅支持)/.test(detail)
          ? detail
          : '图片导入失败，请试用 PNG / JPEG 静态图片。',
      )
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }
  async function addNote() {
    setMessageScope('content')
    setMessage('')
    setBusy(true)
    try {
      const card = await window.codepulse.addAmbientNote(note)
      setCategory('local')
      setNote('')
      setSnapshot(await window.codepulse.getAmbient())
      setSelectedId(card.id)
      setPreview(await window.codepulse.previewAmbient(card.id))
      setMessage('便签已保存在本机，可预览；连接设备后可临时展示。')
    } catch {
      setMessage('便签保存失败，请填写 1–120 字的内容。')
    } finally {
      setBusy(false)
    }
  }
  const visibleCards =
    snapshot?.cards.filter((c) =>
      category === 'local'
        ? c.kind === 'image' || c.kind === 'note'
        : category === 'social'
          ? c.kind === 'x' || c.kind === 'meme'
          : c.kind === (category === 'news' ? 'news' : category),
    ) ?? []
  const previewStatus =
    preview && target
      ? {
          ...preview,
          display: target.status.display ? { ...target.status.display, page: 0 } : preview.display,
        }
      : preview
  const selectedCard =
    category === 'pet'
      ? (visibleCards.find((c) => c.pet?.id === draft.petId) ?? visibleCards[0])
      : (visibleCards.find((c) => c.id === selectedId) ?? visibleCards[0])
  const current = CATEGORIES.find((c) => c.id === category)!
  const currentFlag = RULE_FLAG[category]
  const ruleOn = currentFlag
    ? draft[currentFlag]
    : category === 'social'
      ? draft.xEnabled || draft.memeEnabled
      : false
  const chip = product ? inkPlanChip(product.shell.inkPlan, 'ambient', ink?.connection, locale) : undefined
  const nextAutoAt = snapshot && 'nextAutoAt' in snapshot ? (snapshot as { nextAutoAt?: number | null }).nextAutoAt : undefined
  const openPlaylist = (): void => {
    if (product) void product.navigate('control').then(() => product.selectTarget('ink'))
  }
  const number = (name: NumberField, label: string, min: number, max: number, disabled = false) => (
    <NumberRule
      label={label}
      value={draft[name]}
      min={min}
      max={max}
      disabled={disabled}
      onCommit={(value) => edit(name, value)}
    />
  )
  const ruleSwitch = (flag: NonNullable<(typeof RULE_FLAG)[Category]> | 'xEnabled' | 'memeEnabled', label: string) => (
    <label className="page-switch">
      <input type="checkbox" checked={draft[flag]} onChange={(e) => edit(flag, e.target.checked)} />
      {label}
    </label>
  )
  return (
    <section
      className={'ambient-panel' + (dragging ? ' is-dragging' : '')}
      aria-label="桌边内容"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void importFile(e.dataTransfer.files[0])
      }}
    >
      <PageHeader
        title="桌边内容"
        subtitle="管理可以出现在墨水屏上的内容，以及自动挑选的规则"
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg"
              hidden
              onChange={(e) => void importFile(e.target.files?.[0])}
            />
            <span className="page-muted">图片拖进此页即可导入</span>
            <button type="button" className="product-button" disabled={busy} onClick={() => fileInput.current?.click()}>
              选择图片
            </button>
          </>
        }
      />
      <div className="ambient-info">
        <span>
          是否进入轮播、停留多久在{' '}
          {product ? (
            <button type="button" className="page-link" onClick={openPlaylist}>
              控制 › 节目单
            </button>
          ) : (
            '控制 › 节目单'
          )}{' '}
          设置
        </span>
        {chip && <span className={`page-chip ${chip.included ? 'is-on' : ''}`}>{chip.text}</span>}
      </div>
      <div className="ambient-tabs" role="tablist" aria-label="内容分类">
        {CATEGORIES.map(({ id, label }) => (
          <button
            type="button"
            role="tab"
            key={id}
            aria-selected={category === id}
            onClick={() => {
              setCategory(id)
              setSelectedId('')
              setPreview(undefined)
              // One card a day, so the page opens on it, like picking a pet does.
              const today =
                id === 'calendar' ? snapshot?.cards.find((c) => c.kind === 'calendar') : undefined
              if (today) void showPreview(today)
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="ambient-grid">
        <div className="ambient-card ambient-preview-column">
          <div className="page-card-head">
            <div>
              <h2>{current.label}</h2>
              <p className="page-card-sub">
                400 × 300 预览{ruleOn || category === 'local' ? '' : ' · 未加入挑选规则，仅可手动展示'}
              </p>
            </div>
          </div>
          {category === 'pet' && visibleCards.length > 0 && (
            <div className="ambient-pet-picker" role="radiogroup" aria-label="选择宠物形象">
              {visibleCards.map((c) => {
                const chosen = c.pet?.id === selectedCard?.pet?.id
                return (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={chosen}
                    key={c.id}
                    disabled={busy}
                    className="ambient-pet-option"
                    title={c.pet ? petProfile(c.pet.id).trait : undefined}
                    onClick={() => {
                      if (c.pet) edit('petId', c.pet.id)
                      void showPreview(c)
                    }}
                  >
                    <PetThumb card={c} />
                    <strong>{c.pet ? petProfile(c.pet.id).name : c.source}</strong>
                    <span>{c.pet ? petProfile(c.pet.id).trait : ''}</span>
                    {chosen && <em>已选</em>}
                  </button>
                )
              })}
            </div>
          )}
          {category !== 'pet' && category !== 'calendar' && selectedCard && (
            <div className="ambient-select-card">
              <select
                aria-label="选择内容"
                value={selectedCard?.id ?? ''}
                disabled={busy}
                onChange={(e) => {
                  const card = visibleCards.find((c) => c.id === e.target.value)
                  if (card) void showPreview(card)
                }}
              >
                {visibleCards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.source} · {c.text.slice(0, 28)}
                  </option>
                ))}
              </select>
              <button type="button" className="product-button" disabled={busy} onClick={() => void showPreview(selectedCard)}>
                预览画面
              </button>
            </div>
          )}
          {category === 'calendar' && selectedCard?.calendar && (
            <div className="ambient-calendar-info" role="status">
              <p>
                {selectedCard.text}
                {nextHolidayText(snapshot?.calendarNext)}
              </p>
              <small>月历需要固件 0.0.29 以上，旧固件只显示一行文字</small>
            </div>
          )}
          <section className="ambient-stage">
            <div className="ambient-stage-label">
              <span>{preview ? '内容示例' : '当前目标画面'}</span>
              {preview && (
                <button type="button" className="product-button is-compact" onClick={() => setPreview(undefined)}>
                  返回实时画面
                </button>
              )}
            </div>
            {preview || target ? (
              <DeviceScreenPreview
                status={previewStatus ?? target!.status}
                sample={Boolean(preview)}
                live={!preview}
                fit
              />
            ) : (
              <p className="ambient-empty">
                {targetError ? '预览暂不可用，等待设备服务连接。' : '正在读取当前画面…'}
              </p>
            )}
            {targetError && target && !preview && (
              <p className="page-muted" role="status">
                连接暂时中断，当前显示最后收到的目标画面。
              </p>
            )}
            <p className="ambient-message" data-feedback="content" role="status">
              {messageScope === 'content' ? message : ''}
            </p>
            <div className="ambient-display-actions">
              <button
                type="button"
                className="product-button primary"
                disabled={busy || !selectedCard || !online}
                onClick={() =>
                  selectedCard &&
                  void action(async () => {
                    const state = await window.codepulse.showAmbient(selectedCard.id)
                    setPreview(undefined)
                    return state
                  }, '已临时展示到墨水屏，10 分钟后自动回到节目单。')
                }
              >
                临时展示到墨水屏 · 10 分钟
              </button>
              {!online && <span className="page-muted">连接设备后可临时展示</span>}
            </div>
          </section>
          {category === 'local' && (
            <div className="ambient-note-editor">
              <label htmlFor="ambient-note">写一张便签</label>
              <textarea
                id="ambient-note"
                maxLength={120}
                rows={3}
                placeholder="今天只做一件最重要的事……"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button type="button" className="product-button" disabled={busy || !note.trim()} onClick={() => void addNote()}>
                保存并预览
              </button>
              <small>{note.length} / 120 · 最近 8 张个人内容</small>
            </div>
          )}
          <h3 className="ambient-candidates-title">可选内容</h3>
          <div className="ambient-cards">
            {!visibleCards.length && (
              <p className="ambient-empty">暂时没有合适内容。屏幕继续显示工作状态与用量。</p>
            )}
            {(selectedCard ? [selectedCard] : []).map((card) => (
              <article className="ambient-item" key={card.id}>
                <div className="ambient-card-meta">
                  <strong>{card.source}</strong>
                  <span>
                    {['x', 'meme', 'news'].includes(card.kind)
                      ? `${card.score.toLocaleString()} 赞 · `
                      : '本机内容 · '}
                    {card.kind === 'meme' ? '采集于 ' : ''}
                    {new Date(card.publishedAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                <p>{card.text}</p>
                {card.calendar && (
                  <p className="ambient-hint">
                    每天最多出现一次，红色需要完整刷新，约 16 秒，所以进出各刷新一次。
                  </p>
                )}
                {card.pet && (
                  <p className="ambient-hint">
                    此刻心情：{petMoodLabel(card.pet.mood).label}（
                    {petMoodLabel(card.pet.mood).hint}
                    ）。心情随工作状态和本地时间变化，选好形象后可随时手动展示。
                    自动挑选只在允许展示的时段出场：安静时段和 Agent
                    工作时不会出现（可在“展示节奏”里调整），
                    所以“犯困”“陪你干活”多半只在手动展示时看到。屏幕上的红色需要完整刷新，约 16
                    秒并会闪一下， 所以宠物只在展示和退场时刷新两次。
                  </p>
                )}
                <div className="ambient-actions">
                  {card.url && (
                    <button
                      type="button"
                      className="product-button is-compact"
                      onClick={() =>
                        void window.codepulse
                          .openAmbient(card.id)
                          .catch(() => setMessage('原帖暂时无法打开'))
                      }
                    >
                      {card.kind === 'concept' ? '延伸阅读 ↗' : '查看来源 ↗'}
                    </button>
                  )}
                  {(card.kind === 'image' || card.kind === 'note') && (
                    <button
                      type="button"
                      className="product-button is-compact"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          const s = await window.codepulse.removeAmbient(card.id)
                          setPreview(undefined)
                          return s
                        })
                      }
                    >
                      移除
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>
        <aside className="ambient-card ambient-configuration" aria-label="挑选规则">
          <div className="page-card-head">
            <div>
              <h2>挑选规则</h2>
              <p className="page-card-sub">决定自动展示时从哪些类别里挑</p>
            </div>
            <span className={`page-saved ${savedFlash ? 'is-shown' : ''}`} role="status">
              {savedFlash ? '已保存' : ''}
            </span>
          </div>
          {saveFailed && (
            <p className="ambient-message" role="alert">
              保存未完成，请检查输入后重试。
            </p>
          )}
          <fieldset className="ambient-rules" disabled={!snapshot}>
            <p className="page-muted ambient-status" role="status">
              <span>
                {ink && ink.showing.kind !== 'work'
                  ? showingText(ink, locale)
                  : snapshot?.pausedReason || '等待下一次展示机会'}
              </span>
              <span>
                今日 {snapshot?.shownToday ?? 0} / {snapshot?.config.dailyLimit ?? 6} 条
                {typeof nextAutoAt === 'number' && ` · 下次最早 ${new Date(nextAutoAt).toTimeString().slice(0, 5)}`}
              </span>
            </p>
            {CATEGORIES.map(({ id, label, rule }) => {
              const flag = RULE_FLAG[id]
              return (
                <div className={`ambient-rule${id === category ? ' is-current' : ''}`} key={id} data-rule={id}>
                  {flag ? ruleSwitch(flag, label) : <span className="ambient-rule-name">{label}</span>}
                  <p className="page-muted">{rule}</p>
                  {id === 'pet' && (
                    <p className="page-muted">当前形象：{petProfile(draft.petId).name}（在上方“像素宠物”里更换）</p>
                  )}
                  {id === 'social' && (
                    <div className="ambient-subrules">
                      {ruleSwitch('xEnabled', '订阅 X 贴文')}
                      {ruleSwitch('memeEnabled', '启用 meme')}
                    </div>
                  )}
                </div>
              )
            })}
            <details className="ambient-details">
              <summary>X 贴文 · 来源与筛选</summary>
              <div className={`ambient-subfields${draft.xEnabled ? '' : ' is-dim'}`}>
                <div className="ambient-fields">
                  <label className="page-field">
                    接入方式
                    <select
                      value={draft.provider}
                      disabled={!draft.xEnabled}
                      onChange={(e) => edit('provider', e.target.value as AmbientConfig['provider'])}
                    >
                      <option value="twitterapi">TwitterAPI.io · 第三方按量付费</option>
                      <option value="x">X 官方 API · 按量付费</option>
                    </select>
                  </label>
                  <div className="ambient-key-row">
                    <label className="page-field">
                      API 密钥
                      <input
                        type="password"
                        autoComplete="off"
                        value={key}
                        disabled={!draft.xEnabled}
                        placeholder={
                          snapshot?.hasKey && snapshot.config.provider === draft.provider
                            ? '已保存，留空保留'
                            : '填入对应来源的 API 密钥'
                        }
                        onChange={(e) => setKey(e.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="product-button"
                      disabled={busy || !key.trim() || !draft.xEnabled}
                      onClick={() =>
                        void action(
                          async () => {
                            const state = await window.codepulse.setAmbientKey(draft.provider, key)
                            setKey('')
                            return state
                          },
                          '密钥已加密保存在本机。',
                          'settings',
                        )
                      }
                    >
                      保存密钥
                    </button>
                  </div>
                </div>
                <p className="page-muted">
                  密钥通过系统加密保存在本机，API 费用由所选服务按量计收。这里展示指定账号的热门原帖。
                </p>
                <label className="page-field">
                  账号（逗号分隔）
                  <input
                    value={draft.accounts.join(', ')}
                    disabled={!draft.xEnabled}
                    onChange={(e) => edit('accounts', e.target.value.split(/[,，\s]+/), SAVE_DELAY_MS)}
                  />
                </label>
                <div className="ambient-fields">
                  <label className="page-field">
                    必须包含任一关键词（可留空）
                    <input
                      value={draft.keywords.join(', ')}
                      disabled={!draft.xEnabled}
                      onChange={(e) =>
                        edit('keywords', e.target.value.split(/[,，]/).map((s) => s.trimStart()), SAVE_DELAY_MS)
                      }
                    />
                  </label>
                  <label className="page-field">
                    排除关键词
                    <input
                      value={draft.exclude.join(', ')}
                      disabled={!draft.xEnabled}
                      onChange={(e) =>
                        edit('exclude', e.target.value.split(/[,，]/).map((s) => s.trimStart()), SAVE_DELAY_MS)
                      }
                    />
                  </label>
                  {number('minLikes', '最低点赞数', 0, 1000000, !draft.xEnabled)}
                  {number('dailyRequestLimit', '每天最多检查 X（含手动检查）', 1, 96, !draft.xEnabled)}
                </div>
                <p className="page-muted">
                  默认关注 Polymarket、马斯克和 AI 官方账号。只收近 12
                  小时原帖，过滤回复、转发和敏感标记；作者观点会保留来源，不转换为已证实新闻。
                </p>
                <details>
                  <summary>按账号调整门槛 · 马斯克默认 50,000 赞</summary>
                  <div className="ambient-fields">
                    {[
                      ...new Set(
                        draft.accounts
                          .map((a) => a.replace(/^@/, '').trim())
                          .filter((a) => /^[A-Za-z0-9_]{1,15}$/.test(a)),
                      ),
                    ].map((account) => (
                      <NumberRule
                        key={account}
                        label={`@${account} 最低赞数`}
                        value={draft.accountMinLikes[account.toLowerCase()] ?? draft.minLikes}
                        min={0}
                        max={1000000}
                        disabled={!draft.xEnabled}
                        onCommit={(value) =>
                          edit('accountMinLikes', {
                            ...draft.accountMinLikes,
                            [account.toLowerCase()]: value,
                          })
                        }
                      />
                    ))}
                  </div>
                </details>
                <p className="page-muted">
                  每次只读一页：第三方最多 20 条，官方最多 10 条。展示上限与 API
                  费用不同，建议同时设置来源后台的消费上限。今日已检查 X{' '}
                  {snapshot?.xRequestsToday ?? 0} 次。
                </p>
                <button
                  type="button"
                  className="product-button"
                  disabled={busy || !snapshot?.hasKey || !draft.xEnabled}
                  onClick={() =>
                    void action(
                      () => window.codepulse.setAmbientKey(draft.provider, ''),
                      '已清除该来源密钥',
                      'settings',
                    )
                  }
                >
                  清除该来源密钥
                </button>
              </div>
            </details>
            <details className="ambient-details">
              <summary>Meme · 少量高热度图片</summary>
              <div className={`ambient-subfields${draft.memeEnabled ? '' : ' is-dim'}`}>
                <div className="ambient-fields">
                  <label className="page-field">
                    来源
                    <select
                      value={draft.memeCommunity}
                      disabled={!draft.memeEnabled}
                      onChange={(e) =>
                        edit('memeCommunity', e.target.value as AmbientConfig['memeCommunity'])
                      }
                    >
                      <option value="memes">r/memes</option>
                      <option value="dankmemes">r/dankmemes</option>
                      <option value="ProgrammerHumor">r/ProgrammerHumor</option>
                    </select>
                  </label>
                  {number('memeMinUps', '最低赞数', 0, 1000000, !draft.memeEnabled)}
                </div>
                <p className="page-muted">
                  从公开来源一次取 20 个候选，再按赞数筛选；这是候选中的高赞内容，并非全站热榜。来自
                  Reddit 的 PNG / JPEG
                  图片，无需账号。保留原帖入口，自动适配黑白小屏；跳过成人内容、剧透、动图和超大图片；竖图保持比例并留白。
                </p>
              </div>
            </details>
            <details className="ambient-details">
              <summary>展示节奏</summary>
              <label className="page-switch">
                <input
                  type="checkbox"
                  checked={draft.idleOnly}
                  onChange={(e) => edit('idleOnly', e.target.checked)}
                />
                仅在 Agent 空闲时展示
              </label>
              <div className="ambient-fields">
                {number('pollMinutes', '检查间隔（分钟）', 15, 1440)}
                {number('gapMinutes', '展示间隔（分钟）', 30, 1440)}
                {number('dailyLimit', '每天最多展示', 1, 24)}
                {number('quietStart', '安静时段开始（本地小时）', 0, 23)}
                {number('quietEnd', '安静时段结束（本地小时）', 0, 23)}
              </div>
              <p className="page-muted">
                起止小时相同表示不设安静时段。以上只限制自动挑选；手动展示可跳过空闲、间隔与每日上限，也可暂时覆盖待查看；
                授权、补充输入及异常提醒仍优先。图片与便签只手动展示。每项停留多久在“控制 › 节目单”设置。
              </p>
            </details>
            <p className="ambient-message" data-feedback="settings" role="status">
              {messageScope === 'settings' ? message : ''}
            </p>
            <div className="ambient-actions">
              <button
                type="button"
                className="product-button"
                disabled={busy || !snapshot || snapshot?.collecting}
                onClick={() =>
                  void action(
                    () => window.codepulse.refreshAmbient(),
                    '内容检查完成，来源状态见下方。',
                    'settings',
                  )
                }
              >
                {snapshot?.collecting ? '正在检查…' : '检查新内容'}
              </button>
            </div>
            <div className="ambient-health">
              <span>概念 / 思考：离线可用，无需密钥</span>
              <span>科技热议：{snapshot?.sourceStatus.news ?? '尚未检查'}</span>
              <span>X：{snapshot?.sourceStatus.x ?? '正在连接'}</span>
              <span>Meme：{snapshot?.sourceStatus.meme ?? '正在连接'}</span>
              {Boolean(snapshot?.lastCheckedAt) && (
                <span>最近检查 {new Date(snapshot!.lastCheckedAt).toLocaleTimeString()}</span>
              )}
            </div>
            <p className="page-muted">规则修改后立即保存</p>
          </fieldset>
        </aside>
      </div>
    </section>
  )
}
