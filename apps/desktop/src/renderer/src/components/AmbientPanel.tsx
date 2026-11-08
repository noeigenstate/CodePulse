import { Fragment, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_AMBIENT,
  normalizeAmbient,
  petProfile,
  type AmbientCard,
  type AmbientConfig,
  type AmbientSnapshot,
  type CalendarNextHoliday,
  type DeviceStatusV1,
  type YuanbaoConfig,
  type YuanbaoStatus,
  type YuanbaoTopic,
} from '@codepulse/shared'
import { DeviceScreenPreview } from './DeviceScreenPreview.js'
import { PageHeader } from './PageHeader.js'
import { InfoTip } from './InfoTip.js'
import { YuanbaoSettings } from './YuanbaoSettings.js'
import { planesToRgba } from '../device-preview/renderer.mjs'
import './ambient-panel.css'
import { useScreenTarget } from '../lib/useScreenTarget.js'
import { useInkStatus } from '../lib/useInkStatus.js'
import { inkPlanChip } from '../lib/inkStatusText.js'
import { yuanbaoRowError } from '../lib/yuanbaoStatus.js'
import {
  cardCategory,
  categoryProblem,
  refreshSummary,
  type AmbientCategory,
} from '../lib/ambientStatus.js'
import {
  lifeRowOn,
  lifeTripleOf,
  parseStocks,
  parseTools,
  readRememberedLife,
  rememberAfterLifeFlag,
  setYuanbaoFlag,
  toggleLifeRow,
  withDerivedEnabled,
  writeRememberedLife,
  type LifeTriple,
  type YuanbaoFlag,
} from '../lib/yuanbaoRows.js'
import {
  readRememberedSocial,
  rememberAfterFlag,
  toggleSocialRow,
  writeRememberedSocial,
  type SocialPair,
} from '../lib/ambientSocial.js'

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

type Category = AmbientCategory
type YuanbaoCategory = 'life' | 'tools' | 'holiday' | 'headlines'
const isYuanbao = (id: Category): id is YuanbaoCategory =>
  id === 'life' || id === 'tools' || id === 'holiday' || id === 'headlines'
/** The list order is the page order: a category row is the category's own *Enabled rule. */
const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'concept', label: '概念卡' },
  { id: 'prompt', label: '思考实验' },
  { id: 'pet', label: '像素宠物' },
  { id: 'calendar', label: '日历' },
  { id: 'news', label: '科技热议' },
  { id: 'social', label: 'X 与 meme' },
  { id: 'local', label: '我的图片与便签' },
  { id: 'plugin', label: '插件' },
  { id: 'life', label: '生活卡' },
  { id: 'tools', label: '工具更新' },
  { id: 'holiday', label: '假日公告' },
  { id: 'headlines', label: '今日要闻' },
]
/** Built-in samples shown (tagged 示例) while a 元宝搜索 category has no card yet. */
const SAMPLES: Record<YuanbaoCategory, { topic: YuanbaoTopic; label: string }[]> = {
  life: [
    { topic: 'weather', label: '天气' },
    { topic: 'gold', label: '金价' },
    { topic: 'stock', label: '股价' },
  ],
  tools: [{ topic: 'tools', label: '工具更新' }],
  holiday: [{ topic: 'holiday', label: '假日公告' }],
  headlines: [{ topic: 'news', label: '今日要闻' }],
}
const HOLIDAY_STATE = { published: '已发布', pending: '尚未发布', synced: '已同步' } as const
const RULE_FLAG: Partial<
  Record<
    Category,
    'conceptsEnabled' | 'promptsEnabled' | 'petEnabled' | 'calendarEnabled' | 'newsEnabled'
  >
> = {
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
function NumberRule({
  label,
  hint,
  value,
  min,
  max,
  disabled,
  onCommit,
}: {
  label: string
  hint?: string
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
    <label className="page-field" title={hint}>
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

/** One-line label for an item in the middle list; the preview carries the content itself. */
function itemLabel(card: AmbientCard): string {
  if (card.pet) return petProfile(card.pet.id).name
  if (card.kind === 'calendar') return card.text
  const text = card.text.replace(/\s+/g, ' ').slice(0, 60)
  return ['x', 'meme', 'news'].includes(card.kind) ? `${card.source} · ${text}` : text
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
  const { target, error: targetError, retry: retryTarget } = useScreenTarget(active)
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const savedConfig = useRef<AmbientConfig>()
  const draftRef = useRef(draft)
  draftRef.current = draft
  const previewedId = useRef('')
  // Only the newest preview request may land; a slower, older answer is dropped.
  const previewSeq = useRef(0)
  // The pair behind the 「X 与 meme」 row switch while it is off.
  const rememberedSocial = useRef<SocialPair | undefined>(readRememberedSocial(window.localStorage))
  // The triple behind the 「生活卡」 row switch while it is off.
  const rememberedLife = useRef<LifeTriple | undefined>(readRememberedLife(window.localStorage))
  const [sampleTopic, setSampleTopic] = useState<YuanbaoTopic>()
  const [stocksText, setStocksText] = useState('')
  const [stocksError, setStocksError] = useState('')
  const [toolsText, setToolsText] = useState('')
  const [refreshNote, setRefreshNote] = useState('')
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>()
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
      clearTimeout(refreshTimer.current)
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
  const editMany = (patch: Partial<AmbientConfig>, delay = 0) => {
    const next = { ...draftRef.current, ...patch }
    draftRef.current = next
    setDraft(next)
    unsaved.current = true
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void persist(draftRef.current), delay)
  }
  const edit = <K extends keyof AmbientConfig>(name: K, value: AmbientConfig[K], delay = 0) =>
    editMany({ [name]: value } as Partial<AmbientConfig>, delay)
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
    // Marked before the request so a failed preview is not retried on every snapshot update.
    previewedId.current = card.id
    const seq = ++previewSeq.current
    setMessageScope('content')
    setMessage('')
    setSampleTopic(undefined)
    setSelectedId(card.id)
    try {
      const next = await window.codepulse.previewAmbient(card.id)
      if (seq === previewSeq.current) setPreview(next)
    } catch {
      if (seq === previewSeq.current) setMessage('这条内容已过期，请刷新候选。')
    }
  }
  /** A built-in sample for a 元宝搜索 topic: no network, no quota; tagged 示例 in the preview. */
  async function previewSample(topic: YuanbaoTopic) {
    previewedId.current = `sample:${topic}`
    const seq = ++previewSeq.current
    setMessageScope('content')
    setMessage('')
    setSelectedId('')
    setSampleTopic(topic)
    try {
      const next = await window.codepulse.previewYuanbaoSample?.(topic)
      if (seq === previewSeq.current) setPreview(next)
    } catch {
      if (seq === previewSeq.current) setPreview(undefined)
    }
  }
  async function importFiles(files: File[]) {
    if (!files.length || busy) return
    setMessageScope('content')
    setBusy(true)
    setMessage('')
    let imported = 0
    let last: AmbientCard | undefined
    try {
      for (const file of files) {
        if (file.size > 8000000 || !/\.(png|jpe?g)$/i.test(file.name))
          throw new Error('请选择 8 MB 内的 PNG / JPEG 图片')
        last = await window.codepulse.importAmbientImage(
          new Uint8Array(await file.arrayBuffer()),
          file.name,
        )
        imported += 1
      }
      setCategory('local')
      setSnapshot(await window.codepulse.getAmbient())
      if (last) await selectImported(last)
      setMessage(`已导入 ${imported} 张图片`)
    } catch (error) {
      const detail = error instanceof Error ? error.message.split('Error: ').pop()! : ''
      const reason = /^(请选择|图片|仅支持)/.test(detail)
        ? detail
        : '图片导入失败，请试用 PNG / JPEG 静态图片。'
      // Pictures imported before the failure are real: show them and say which one failed.
      if (imported > 0) {
        setCategory('local')
        try {
          setSnapshot(await window.codepulse.getAmbient())
          if (last) await selectImported(last)
        } catch {
          // The list refreshes on the next update.
        }
        setMessage(`已导入 ${imported} 张，第 ${imported + 1} 张失败：${reason}`)
      } else {
        setMessage(reason)
      }
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }
  /** Select a freshly imported card and preview it, unless another request has overtaken this one. */
  async function selectImported(card: AmbientCard) {
    previewedId.current = card.id
    const seq = ++previewSeq.current
    setSelectedId(card.id)
    const next = await window.codepulse.previewAmbient(card.id)
    if (seq === previewSeq.current) setPreview(next)
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
      await selectImported(card)
    } catch {
      setMessage('便签保存失败，请填写 1–120 字的内容。')
    } finally {
      setBusy(false)
    }
  }
  const cardsFor = (id: Category): AmbientCard[] =>
    snapshot?.cards.filter((c) => cardCategory(c) === id) ?? []
  const visibleCards = cardsFor(category)
  const selectedCard =
    category === 'pet'
      ? (visibleCards.find((c) => c.pet?.id === draft.petId) ?? visibleCards[0])
      : (visibleCards.find((c) => c.id === selectedId) ?? visibleCards[0])
  // Pets are one item (the chosen pet); the picker for the others sits in 设置.
  const items = category === 'pet' ? (selectedCard ? [selectedCard] : []) : visibleCards
  // Opening a category (or choosing a pet) previews its selected item without another click.
  useEffect(() => {
    if (active && snapshot && selectedCard && previewedId.current !== selectedCard.id)
      void showPreview(selectedCard)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, snapshot, selectedCard?.id])
  useEffect(() => {
    if (!active || !snapshot || !isYuanbao(category) || visibleCards.length > 0) return
    const topic = sampleTopic ?? SAMPLES[category][0]!.topic
    if (previewedId.current !== `sample:${topic}`) void previewSample(topic)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, snapshot, category, visibleCards.length, sampleTopic])
  // `holiday` arrives with the host's next contract revision; read it defensively until then.
  const yb = snapshot?.yuanbao as
    | (YuanbaoStatus & { holiday?: { year: number; state: keyof typeof HOLIDAY_STATE } | null })
    | undefined
  const hasYbKey = Boolean(yb?.hasKey)
  // Per-topic errors arrive with the host's next contract revision; read them defensively until then.
  const ybErrors = (yb as { errors?: Partial<Record<YuanbaoTopic, string>> } | undefined)?.errors
  const ybConfig = draft.yuanbao
  // Keep the text fields in step with the saved config unless the typed text already says the same.
  useEffect(() => {
    const parsed = parseStocks(stocksText)
    if (!(parsed.ok && parsed.stocks.join() === ybConfig.stocks.join()))
      setStocksText(ybConfig.stocks.join(', '))
    if (parseTools(toolsText).join() !== ybConfig.tools.join())
      setToolsText(ybConfig.tools.join(', '))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ybConfig.stocks.join(), ybConfig.tools.join()])
  /** Saves a 元宝搜索 change; `enabled` is always re-derived from the six feature flags. */
  const editYuanbao = (patch: Partial<YuanbaoConfig>, delay = 0) =>
    editMany({ yuanbao: withDerivedEnabled({ ...draftRef.current.yuanbao, ...patch }) }, delay)
  const previewStatus =
    preview && target
      ? {
          ...preview,
          display: target.status.display ? { ...target.status.display, page: 0 } : preview.display,
        }
      : preview
  const enabledSources = { x: draft.xEnabled, meme: draft.memeEnabled, news: draft.newsEnabled }
  const ybRowOn = (id: YuanbaoCategory): boolean =>
    id === 'life'
      ? lifeRowOn(lifeTripleOf(ybConfig))
      : id === 'tools'
        ? ybConfig.toolsEnabled
        : id === 'holiday'
          ? ybConfig.holidayEnabled
          : ybConfig.newsEnabled
  const problem =
    categoryProblem(category, snapshot?.sourceStatus, enabledSources) ||
    (isYuanbao(category) && ybRowOn(category) ? yuanbaoRowError(category, ybErrors) : '')
  const chip = product
    ? inkPlanChip(product.shell.inkPlan, 'ambient', ink?.connection, locale)
    : undefined
  const openPlaylist = (): void => {
    if (product) void product.navigate('control').then(() => product.selectTarget('ink'))
  }
  const number = (
    name: NumberField,
    label: string,
    min: number,
    max: number,
    disabled = false,
    hint?: string,
  ) => (
    <NumberRule
      label={label}
      hint={hint}
      value={draft[name]}
      min={min}
      max={max}
      disabled={disabled}
      onCommit={(value) => edit(name, value)}
    />
  )
  const flagSwitch = (flag: 'xEnabled' | 'memeEnabled', label: string) => (
    <label className="page-switch">
      <input
        type="checkbox"
        checked={draft[flag]}
        onChange={(e) => {
          const value = e.target.checked
          rememberedSocial.current = rememberAfterFlag(
            { xEnabled: draft.xEnabled, memeEnabled: draft.memeEnabled },
            flag,
            value,
          )
          writeRememberedSocial(window.localStorage, rememberedSocial.current)
          edit(flag, value)
        }}
      />
      {label}
    </label>
  )
  async function refreshNow() {
    const before = new Set(snapshot?.cards.map((c) => c.id))
    const show = (text: string) => {
      setRefreshNote(text)
      clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(() => setRefreshNote(''), 4000)
    }
    setBusy(true)
    setRefreshNote('')
    try {
      if (category === 'plugin') await window.codepulse.pluginsChanged()
      const state = await (category === 'plugin'
        ? window.codepulse.getAmbient()
        : window.codepulse.refreshAmbient())
      setSnapshot(state)
      show(
        refreshSummary(
          category,
          before,
          state.cards,
          categoryProblem(category, state.sourceStatus, enabledSources),
        ),
      )
    } catch {
      show('检查未完成，请稍后重试')
    } finally {
      setBusy(false)
    }
  }
  const refreshButton = (
    <button
      type="button"
      className="product-button"
      disabled={busy || !snapshot || snapshot.collecting}
      onClick={() => void refreshNow()}
    >
      {snapshot?.collecting ? '正在检查…' : '检查新内容'}
    </button>
  )
  // The corner tag says whether the previewed card is the one on the e-ink screen now (projected card ids).
  const onScreen =
    Boolean(preview?.ambient?.id) &&
    (ink?.showing.kind === 'ambient' || ink?.showing.kind === 'todos') &&
    ink.showing.id === preview?.ambient?.id
  const selectedCanOpen = Boolean(selectedCard?.url)
  const selectedRemovable =
    selectedCard && (selectedCard.kind === 'image' || selectedCard.kind === 'note')
  const hasSettings = ['pet', 'news', 'social', 'life', 'tools', 'headlines'].includes(category)
  const rowOn = (id: Category): boolean =>
    isYuanbao(id)
      ? ybRowOn(id)
      : id === 'social'
        ? draft.xEnabled || draft.memeEnabled
        : RULE_FLAG[id]
          ? draft[RULE_FLAG[id]!]
          : false
  const holidayStatus = yb?.holiday
    ? `${yb.holiday.year} 放假安排：${HOLIDAY_STATE[yb.holiday.state]}`
    : ''
  const toggleYuanbaoRow = (id: YuanbaoCategory) => {
    if (!hasYbKey) return
    if (id === 'life') {
      const next = toggleLifeRow(lifeTripleOf(ybConfig), rememberedLife.current)
      rememberedLife.current = next.remembered
      writeRememberedLife(window.localStorage, next.remembered)
      editYuanbao(next.patch)
      return
    }
    const flag: YuanbaoFlag =
      id === 'tools' ? 'toolsEnabled' : id === 'holiday' ? 'holidayEnabled' : 'newsEnabled'
    editMany({ yuanbao: setYuanbaoFlag(ybConfig, flag, !ybConfig[flag]) })
  }
  /** An individual weather / gold / stocks switch in 生活卡 设置: the latest choice replaces the row's memory. */
  const lifeFlagSwitch = (flag: keyof LifeTriple, label: string) => (
    <label className="page-switch">
      <input
        type="checkbox"
        checked={ybConfig[flag]}
        disabled={!hasYbKey}
        onChange={(e) => {
          const value = e.target.checked
          rememberedLife.current = rememberAfterLifeFlag(lifeTripleOf(ybConfig), flag, value)
          writeRememberedLife(window.localStorage, rememberedLife.current)
          editMany({ yuanbao: setYuanbaoFlag(ybConfig, flag, value) })
        }}
      />
      {label}
    </label>
  )
  const tempReason = !online
    ? '连接设备后可临时展示'
    : sampleTopic
      ? '这是示例，有真实内容后才能临时展示'
      : !selectedCard
        ? '没有可展示的内容'
        : undefined
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
        void importFiles(Array.from(e.dataTransfer.files))
      }}
    >
      <PageHeader
        title="桌边内容"
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg"
              multiple
              hidden
              onChange={(e) => void importFiles(Array.from(e.target.files ?? []))}
            />
            {chip &&
              (product ? (
                <button type="button" className="page-chip is-button" onClick={openPlaylist}>
                  {chip.text}
                </button>
              ) : (
                <span className="page-chip">{chip.text}</span>
              ))}
            <button
              type="button"
              className="product-button"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              选择图片
            </button>
          </>
        }
      />
      <div className="ambient-grid">
        <div className="ambient-card ambient-cats">
          <ul className="ambient-catlist" aria-label="内容分类">
            {CATEGORIES.map(({ id, label }) => {
              const flag = RULE_FLAG[id]
              const count = id === 'pet' ? Math.min(1, cardsFor(id).length) : cardsFor(id).length
              return (
                <Fragment key={id}>
                  {id === 'life' && (
                    <li className="ambient-group-label" role="presentation">
                      <span>元宝搜索</span>
                      {!hasYbKey && (
                        <InfoTip text="先在元宝搜索设置里填写密钥" label="为什么开关不可用" />
                      )}
                    </li>
                  )}
                  <li className={id === category ? 'is-current' : undefined} data-rule={id}>
                    <button
                      type="button"
                      className="ambient-cat-main"
                      data-cat={id}
                      aria-pressed={id === category}
                      onClick={() => {
                        // Re-selecting the current category keeps its selection and preview.
                        if (id === category) return
                        setCategory(id)
                        setSelectedId('')
                        setSampleTopic(undefined)
                        setPreview(undefined)
                        setMessage('')
                        previewedId.current = ''
                        previewSeq.current += 1
                        setRefreshNote('')
                      }}
                    >
                      <span>{label}</span>
                      <span className="ambient-cat-count">{count} 条</span>
                    </button>
                    {id === 'local' && <span className="ambient-manual-tag">仅手动</span>}
                    {isYuanbao(id) && (
                      <button
                        type="button"
                        role="switch"
                        className="ambient-switch"
                        // Without a key nothing can run, so the switch reads off whatever the stored flags say.
                        aria-checked={hasYbKey && rowOn(id)}
                        aria-disabled={!snapshot || !hasYbKey}
                        aria-label={`自动挑选 ${label}`}
                        onClick={() => toggleYuanbaoRow(id)}
                      />
                    )}
                    {(flag || id === 'social') && (
                      <button
                        type="button"
                        role="switch"
                        className="ambient-switch"
                        aria-checked={rowOn(id)}
                        aria-label={`自动挑选 ${label}`}
                        disabled={!snapshot}
                        onClick={() => {
                          if (id !== 'social') return edit(flag!, !draft[flag!])
                          const next = toggleSocialRow(
                            { xEnabled: draft.xEnabled, memeEnabled: draft.memeEnabled },
                            rememberedSocial.current,
                          )
                          rememberedSocial.current = next.remembered
                          writeRememberedSocial(window.localStorage, next.remembered)
                          editMany(next.patch)
                        }}
                      />
                    )}
                  </li>
                </Fragment>
              )
            })}
          </ul>
          <YuanbaoSettings
            status={yb}
            limit={ybConfig.dailyRequestLimit}
            onLimit={(value) => editYuanbao({ dailyRequestLimit: value })}
            onSnapshot={setSnapshot}
            disabled={!snapshot}
            limitField={(value, onCommit) => (
              <NumberRule
                label="每日请求上限"
                value={value}
                min={1}
                max={200}
                onCommit={onCommit}
              />
            )}
          />
          <details className="ambient-details ambient-pacing">
            <summary>展示节奏</summary>
            <fieldset className="ambient-fieldset" disabled={!snapshot}>
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
                {number('quietStart', '安静开始（小时）', 0, 23)}
                {number('quietEnd', '安静结束（小时）', 0, 23)}
              </div>
            </fieldset>
          </details>
        </div>
        <div
          className="ambient-card ambient-detail"
          aria-label={CATEGORIES.find((c) => c.id === category)!.label}
        >
          <div className="page-card-head">
            <div className="ambient-detail-title">
              <h2>{CATEGORIES.find((c) => c.id === category)!.label}</h2>
              {problem && <span className="page-chip is-warn">{problem}</span>}
            </div>
            <span
              className={`page-saved ${savedFlash || refreshNote ? 'is-shown' : ''}`}
              role="status"
            >
              {refreshNote || (savedFlash ? '已保存' : '')}
            </span>
          </div>
          {saveFailed && (
            <p className="ambient-message" role="alert">
              保存未完成，请检查输入后重试。
            </p>
          )}
          <div className="ambient-inner">
            <div className="ambient-items-col">
              <ul className="ambient-items" aria-label="条目">
                {items.length === 0 && !isYuanbao(category) && (
                  <li className="ambient-empty">暂无内容</li>
                )}
                {items.length === 0 &&
                  isYuanbao(category) &&
                  SAMPLES[category].map(({ topic, label }) => (
                    <li key={topic}>
                      <button
                        type="button"
                        className="ambient-item"
                        data-sample={topic}
                        aria-pressed={sampleTopic === topic}
                        onClick={() => void previewSample(topic)}
                      >
                        示例 · {label}
                      </button>
                    </li>
                  ))}
                {items.map((card) => (
                  <li key={card.id}>
                    <button
                      type="button"
                      className="ambient-item"
                      aria-pressed={card.id === selectedCard?.id}
                      title={`${card.text}${['x', 'meme', 'news'].includes(card.kind) ? ` · ${card.score.toLocaleString()} 赞` : ''}`}
                      onClick={() => void showPreview(card)}
                    >
                      {itemLabel(card)}
                    </button>
                  </li>
                ))}
              </ul>
              {category === 'calendar' && selectedCard?.calendar && (
                <p
                  className="ambient-calendar-info"
                  role="status"
                  title="月历需要固件 0.0.29 以上，旧固件只显示一行文字"
                >
                  {selectedCard.text}
                  {nextHolidayText(snapshot?.calendarNext)}
                </p>
              )}
              {(category === 'calendar' || category === 'holiday') && holidayStatus && (
                <p className="ambient-calendar-info" data-holiday-status role="status">
                  {holidayStatus}
                </p>
              )}
              {(selectedCanOpen || selectedRemovable) && (
                <div className="ambient-actions">
                  {selectedCanOpen && selectedCard && (
                    <button
                      type="button"
                      className="product-button is-compact"
                      onClick={() =>
                        void window.codepulse
                          .openAmbient(selectedCard.id)
                          .catch(() => setMessage('原帖暂时无法打开'))
                      }
                    >
                      {selectedCard.kind === 'concept' ? '延伸阅读 ↗' : '查看来源 ↗'}
                    </button>
                  )}
                  {selectedRemovable && selectedCard && (
                    <button
                      type="button"
                      className="product-button is-compact"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          const s = await window.codepulse.removeAmbient(selectedCard.id)
                          setPreview(undefined)
                          previewSeq.current += 1
                          previewedId.current = ''
                          setSelectedId('')
                          return s
                        })
                      }
                    >
                      移除
                    </button>
                  )}
                </div>
              )}
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
                  <button
                    type="button"
                    className="product-button"
                    disabled={busy || !note.trim()}
                    onClick={() => void addNote()}
                  >
                    保存并预览
                  </button>
                  <small>{note.length} / 120</small>
                </div>
              )}
              {hasSettings && (
                <details
                  className="ambient-details ambient-settings"
                  open={settingsOpen}
                  onToggle={(e) => setSettingsOpen(e.currentTarget.open)}
                >
                  <summary>设置</summary>
                  <fieldset className="ambient-fieldset" disabled={!snapshot}>
                    {category === 'pet' && (
                      <div className="ambient-pet-picker" role="radiogroup" aria-label="宠物形象">
                        {cardsFor('pet').map((c) => {
                          const chosen = c.pet?.id === draft.petId
                          return (
                            <button
                              type="button"
                              role="radio"
                              aria-checked={chosen}
                              key={c.id}
                              className="ambient-pet-option"
                              title={c.pet ? petProfile(c.pet.id).trait : undefined}
                              onClick={() => c.pet && edit('petId', c.pet.id)}
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
                    {category === 'news' && <div className="ambient-actions">{refreshButton}</div>}
                    {category === 'life' && (
                      <>
                        <section className="ambient-group" aria-label="天气">
                          <h3>天气</h3>
                          {lifeFlagSwitch('weatherEnabled', '显示天气')}
                          <label className="page-field">
                            城市
                            <input
                              value={ybConfig.city}
                              maxLength={20}
                              onChange={(e) => editYuanbao({ city: e.target.value }, SAVE_DELAY_MS)}
                            />
                          </label>
                        </section>
                        <section className="ambient-group" aria-label="金价">
                          <h3>金价</h3>
                          {lifeFlagSwitch('goldEnabled', '显示金价')}
                          <label className="page-switch">
                            <input
                              type="checkbox"
                              checked={ybConfig.goldBrand}
                              onChange={(e) => editYuanbao({ goldBrand: e.target.checked })}
                            />
                            附品牌金价
                          </label>
                        </section>
                        <section className="ambient-group" aria-label="股票">
                          <h3>股票</h3>
                          {lifeFlagSwitch('stocksEnabled', '显示股价')}
                          <label className="page-field">
                            代码（最多 3 个，逗号分隔）
                            <input
                              value={stocksText}
                              aria-invalid={Boolean(stocksError)}
                              placeholder="00700.hk"
                              onChange={(e) => {
                                setStocksText(e.target.value)
                                const parsed = parseStocks(e.target.value)
                                setStocksError(parsed.ok ? '' : parsed.error)
                                if (parsed.ok) editYuanbao({ stocks: parsed.stocks }, SAVE_DELAY_MS)
                              }}
                            />
                            {stocksError && (
                              <span className="ambient-field-error" role="alert">
                                {stocksError}
                              </span>
                            )}
                          </label>
                        </section>
                        <div className="ambient-actions">{refreshButton}</div>
                      </>
                    )}
                    {category === 'tools' && (
                      <>
                        <label className="page-field">
                          工具名称（最多 4 个，逗号分隔）
                          <input
                            value={toolsText}
                            onChange={(e) => {
                              setToolsText(e.target.value)
                              editYuanbao({ tools: parseTools(e.target.value) }, SAVE_DELAY_MS)
                            }}
                          />
                        </label>
                        <div className="ambient-actions">{refreshButton}</div>
                      </>
                    )}
                    {category === 'headlines' && (
                      <>
                        <label className="page-field">
                          话题
                          <input
                            value={ybConfig.newsTopic}
                            maxLength={20}
                            onChange={(e) =>
                              editYuanbao({ newsTopic: e.target.value }, SAVE_DELAY_MS)
                            }
                          />
                        </label>
                        <div className="ambient-actions">{refreshButton}</div>
                      </>
                    )}
                    {category === 'social' && (
                      <>
                        <section className="ambient-group" aria-label="X 贴文">
                          <h3>X 贴文</h3>
                          {flagSwitch('xEnabled', '订阅 X 贴文')}
                          <div className={`ambient-subfields${draft.xEnabled ? '' : ' is-dim'}`}>
                            <div className="ambient-fields">
                              <label className="page-field">
                                接入方式
                                <select
                                  value={draft.provider}
                                  disabled={!draft.xEnabled}
                                  onChange={(e) =>
                                    edit('provider', e.target.value as AmbientConfig['provider'])
                                  }
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
                                      snapshot?.hasKey &&
                                      snapshot.config.provider === draft.provider
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
                                        const state = await window.codepulse.setAmbientKey(
                                          draft.provider,
                                          key,
                                        )
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
                                  清除密钥
                                </button>
                              </div>
                            </div>
                            <label className="page-field">
                              账号（逗号分隔）
                              <input
                                value={draft.accounts.join(', ')}
                                disabled={!draft.xEnabled}
                                onChange={(e) =>
                                  edit('accounts', e.target.value.split(/[,，\s]+/), SAVE_DELAY_MS)
                                }
                              />
                            </label>
                            <div className="ambient-fields">
                              <label className="page-field">
                                必须包含任一关键词（可留空）
                                <input
                                  value={draft.keywords.join(', ')}
                                  disabled={!draft.xEnabled}
                                  onChange={(e) =>
                                    edit(
                                      'keywords',
                                      e.target.value.split(/[,，]/).map((s) => s.trimStart()),
                                      SAVE_DELAY_MS,
                                    )
                                  }
                                />
                              </label>
                              <label className="page-field">
                                排除关键词
                                <input
                                  value={draft.exclude.join(', ')}
                                  disabled={!draft.xEnabled}
                                  onChange={(e) =>
                                    edit(
                                      'exclude',
                                      e.target.value.split(/[,，]/).map((s) => s.trimStart()),
                                      SAVE_DELAY_MS,
                                    )
                                  }
                                />
                              </label>
                              {number('minLikes', '最低点赞数', 0, 1000000, !draft.xEnabled)}
                              {number(
                                'dailyRequestLimit',
                                '每天最多检查 X',
                                1,
                                96,
                                !draft.xEnabled,
                                `含手动检查；今日已检查 ${snapshot?.xRequestsToday ?? 0} 次`,
                              )}
                            </div>
                            <details className="ambient-details">
                              <summary>按账号调整最低赞数</summary>
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
                                    label={`@${account}`}
                                    value={
                                      draft.accountMinLikes[account.toLowerCase()] ?? draft.minLikes
                                    }
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
                          </div>
                        </section>
                        <section className="ambient-group" aria-label="Meme">
                          <h3>Meme</h3>
                          {flagSwitch('memeEnabled', '启用 meme')}
                          <div className={`ambient-subfields${draft.memeEnabled ? '' : ' is-dim'}`}>
                            <div className="ambient-fields">
                              <label className="page-field">
                                来源
                                <select
                                  value={draft.memeCommunity}
                                  disabled={!draft.memeEnabled}
                                  onChange={(e) =>
                                    edit(
                                      'memeCommunity',
                                      e.target.value as AmbientConfig['memeCommunity'],
                                    )
                                  }
                                >
                                  <option value="memes">r/memes</option>
                                  <option value="dankmemes">r/dankmemes</option>
                                  <option value="ProgrammerHumor">r/ProgrammerHumor</option>
                                </select>
                              </label>
                              {number('memeMinUps', '最低赞数', 0, 1000000, !draft.memeEnabled)}
                            </div>
                          </div>
                        </section>
                        <div className="ambient-actions">{refreshButton}</div>
                      </>
                    )}
                    <p className="ambient-message" data-feedback="settings" role="status">
                      {messageScope === 'settings' ? message : ''}
                    </p>
                  </fieldset>
                </details>
              )}
            </div>
            <div className="ambient-stage-col">
              <section className="ambient-stage">
                {preview || target ? (
                  <DeviceScreenPreview
                    status={previewStatus ?? target!.status}
                    sample={Boolean(preview)}
                    live={!preview}
                    fit
                    compact
                    cornerTag={sampleTopic ? '示例' : onScreen ? '当前画面' : '预览'}
                  />
                ) : targetError ? (
                  <p className="ambient-empty" role="alert">
                    预览暂不可用
                    <button
                      type="button"
                      className="product-button is-compact"
                      onClick={retryTarget}
                    >
                      重试
                    </button>
                  </p>
                ) : (
                  <p className="ambient-empty">正在读取画面…</p>
                )}
                <span className="ambient-temp">
                  <button
                    type="button"
                    className="product-button primary"
                    aria-disabled={busy || !selectedCard || !online}
                    onClick={() => {
                      // aria-disabled keeps the button focusable so its reason can be read; the click is ignored.
                      if (busy || !selectedCard || !online) return
                      void action(async () => {
                        const state = await window.codepulse.showAmbient(selectedCard.id)
                        return state
                      }, '已临时展示，10 分钟后自动回到节目单。')
                    }}
                  >
                    临时展示 10 分钟
                  </button>
                  {tempReason && <InfoTip text={tempReason} label="为什么不能临时展示" />}
                </span>
                <p className="ambient-message" data-feedback="content" role="status">
                  {messageScope === 'content' ? message : ''}
                </p>
              </section>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
