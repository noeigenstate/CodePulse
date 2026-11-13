import { useEffect, useRef, useState } from 'react'
import {
  type AmbientCard,
  type AmbientSnapshot,
  type DeviceStatusV1,
  type YuanbaoConfig,
  type YuanbaoStatus,
  type YuanbaoTopic,
} from '@codepulse/shared'
import {
  RULE_FLAG,
  SAMPLES,
  isYuanbao,
  localPluginRows,
  type Category,
  type YuanbaoCategory,
} from '../lib/localPlugins.js'
import { useAmbientConfig } from './useAmbientConfig.js'
import { useScreenTarget } from '../lib/useScreenTarget.js'
import { useInkStatus } from '../lib/useInkStatus.js'
import { cardCategory, categoryProblem, refreshSummary } from '../lib/ambientStatus.js'
import {
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

export const SAVE_DELAY_MS = 400
const HOLIDAY_STATE = { published: '已发布', pending: '尚未发布', synced: '已同步' } as const
export type NumberField =
  | 'minLikes'
  | 'memeMinUps'
  | 'pollMinutes'
  | 'gapMinutes'
  | 'dailyLimit'
  | 'dailyRequestLimit'
  | 'quietStart'
  | 'quietEnd'

export function useLocalPlugins({ active = true }: { active?: boolean }) {
  const { target, error: targetError, retry: retryTarget } = useScreenTarget(active)
  const ink = useInkStatus(active)
  const online = ink?.connection === 'connected'
  const {
    snapshot,
    setSnapshot,
    draft,
    draftRef,
    edit,
    editMany,
    savedFlash,
    saveFailed,
    loadError,
  } = useAmbientConfig()
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
  const [settingsOpen, setSettingsOpen] = useState(true)
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
  useEffect(() => () => clearTimeout(refreshTimer.current), [])
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
  const setSocialFlag = (flag: 'xEnabled' | 'memeEnabled', value: boolean) => {
    rememberedSocial.current = rememberAfterFlag(
      { xEnabled: draftRef.current.xEnabled, memeEnabled: draftRef.current.memeEnabled },
      flag,
      value,
    )
    writeRememberedSocial(window.localStorage, rememberedSocial.current)
    edit(flag, value)
  }
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
      const state = await window.codepulse.refreshAmbient()
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
  // The corner tag says whether the previewed card is the one on the e-ink screen now (projected card ids).
  const onScreen =
    Boolean(preview?.ambient?.id) &&
    (ink?.showing.kind === 'ambient' || ink?.showing.kind === 'todos') &&
    ink.showing.id === preview?.ambient?.id
  const selectedCanOpen = Boolean(selectedCard?.url)
  const selectedRemovable =
    selectedCard && (selectedCard.kind === 'image' || selectedCard.kind === 'note')
  const hasSettings = ['pet', 'news', 'social', 'life', 'tools', 'headlines'].includes(category)
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
  const setLifeFlag = (flag: keyof LifeTriple, value: boolean) => {
    const config = draftRef.current.yuanbao
    rememberedLife.current = rememberAfterLifeFlag(lifeTripleOf(config), flag, value)
    writeRememberedLife(window.localStorage, rememberedLife.current)
    editMany({ yuanbao: setYuanbaoFlag(config, flag, value) })
  }
  const tempReason = !online
    ? '连接设备后可临时展示'
    : sampleTopic
      ? '这是示例，有真实内容后才能临时展示'
      : !selectedCard
        ? '没有可展示的内容'
        : undefined
  const selectCategory = (id: Category) => {
    if (id === category) return
    setCategory(id)
    setSelectedId('')
    setSampleTopic(undefined)
    setPreview(undefined)
    setMessage('')
    previewedId.current = ''
    previewSeq.current += 1
    setRefreshNote('')
  }
  const toggleCategory = (id: Category) => {
    if (isYuanbao(id)) return toggleYuanbaoRow(id)
    if (id === 'social') {
      const next = toggleSocialRow(
        { xEnabled: draft.xEnabled, memeEnabled: draft.memeEnabled },
        rememberedSocial.current,
      )
      rememberedSocial.current = next.remembered
      writeRememberedSocial(window.localStorage, next.remembered)
      editMany(next.patch)
      return
    }
    const flag = RULE_FLAG[id]
    if (flag) edit(flag, !draftRef.current[flag])
  }
  const removeSelected = () =>
    action(async () => {
      if (!selectedCard) return snapshot!
      const state = await window.codepulse.removeAmbient(selectedCard.id)
      setPreview(undefined)
      previewSeq.current += 1
      previewedId.current = ''
      setSelectedId('')
      return state
    })
  return {
    snapshot,
    draft,
    rows: localPluginRows(snapshot, draft),
    selectCategory,
    toggleCategory,
    category,
    yb,
    ybConfig,
    editYuanbao,
    setSnapshot,
    savedFlash,
    saveFailed,
    loadError,
    dragging,
    setDragging,
    importFiles,
    fileInput,
    busy,
    refreshNote,
    items,
    sampleTopic,
    previewSample,
    selectedCard,
    showPreview,
    holidayStatus,
    selectedCanOpen,
    selectedRemovable,
    action,
    removeSelected,
    note,
    setNote,
    addNote,
    hasSettings,
    settingsOpen,
    setSettingsOpen,
    cardsFor,
    edit,
    refreshNow,
    setLifeFlag,
    stocksText,
    stocksError,
    setStocksText,
    setStocksError,
    toolsText,
    setToolsText,
    setSocialFlag,
    key,
    setKey,
    messageScope,
    message,
    setMessage,
    preview,
    target,
    previewStatus,
    onScreen,
    targetError,
    retryTarget,
    online,
    tempReason,
  }
}
export type LocalPluginModel = ReturnType<typeof useLocalPlugins>
