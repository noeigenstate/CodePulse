import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_AMBIENT,
  petMoodLabel,
  normalizeAmbient,
  petProfile,
  type AmbientCard,
  type AmbientConfig,
  type AmbientSnapshot,
  type DeviceStatusV1,
} from '@codepulse/shared'
import { DeviceScreenPreview } from './DeviceScreenPreview.js'
import { planesToRgba } from '../device-preview/renderer.mjs'
import './ambient-panel.css'
import { useScreenTarget } from '../lib/useScreenTarget.js'

const PET_CROP = { x: 4, y: 8, w: 232, h: 196 }
/**
 * Small look at a pet card's bitmap. It lays the card into the same two planes the device uses
 * and paints them with the shared preview colours, so black wins over red exactly as on the screen.
 */
function PetThumb({ card }: { card: AmbientCard }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const context = canvas.current?.getContext('2d')
    if (!context || !card.imageHex) return
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
    const image = context.createImageData(400, 300)
    image.data.set(planesToRgba(black, red))
    // Only the left of the picture, where every pet stands, so the small thumbnail stays readable.
    context.putImageData(
      image,
      -(8 + PET_CROP.x),
      -(60 + PET_CROP.y),
      8 + PET_CROP.x,
      60 + PET_CROP.y,
      PET_CROP.w,
      PET_CROP.h,
    )
  }, [card.imageHex, card.red])
  return <canvas ref={canvas} width={PET_CROP.w} height={PET_CROP.h} aria-hidden="true" />
}

export function AmbientPanel({ active = true }: { active?: boolean }): JSX.Element {
  const { target, error: targetError } = useScreenTarget(active)
  const [snapshot, setSnapshot] = useState<AmbientSnapshot>()
  const [draft, setDraft] = useState<AmbientConfig>({ ...DEFAULT_AMBIENT })
  const [key, setKey] = useState('')
  const [category, setCategory] = useState<'local' | 'concept' | 'prompt' | 'pet' | 'online'>(
    'concept',
  )
  const [note, setNote] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [messageScope, setMessageScope] = useState<'content' | 'settings'>('content')
  const [preview, setPreview] = useState<DeviceStatusV1>()
  const savedConfig = useRef<AmbientConfig>()
  const draftRef = useRef(draft)
  draftRef.current = draft
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
        if (alive) setMessage('当前桌面服务尚未加载信息推送，请重新启动统一应用。')
      })
    const stop = window.codepulse.onAmbient((s) => {
      received = true
      if (!alive) return
      setSnapshot(s)
      const incoming = normalizeAmbient(s.config)
      if (JSON.stringify(savedConfig.current) !== JSON.stringify(incoming)) {
        const dirty =
          savedConfig.current &&
          JSON.stringify(draftRef.current) !== JSON.stringify(savedConfig.current)
        savedConfig.current = incoming
        if (!dirty) setDraft(incoming)
        else setMessage('另一窗口已更新设置；这里保留你的未保存修改。')
      }
    })
    return () => {
      alive = false
      stop()
    }
  }, [])
  const edit = <K extends keyof AmbientConfig>(name: K, value: AmbientConfig[K]) =>
    setDraft((d) => ({ ...d, [name]: value }))
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
      try {
        setSnapshot(await window.codepulse.showAmbient(card.id))
        setPreview(undefined)
        setMessage('图片已设为目标画面，联网屏幕会在当前刷新结束后获取。')
      } catch (error) {
        const detail = error instanceof Error ? error.message.split('Error: ').pop()! : ''
        setMessage(
          /^先处理 Agent/.test(detail)
            ? `图片已准备好。${detail}`
            : '图片已保存，但展示未完成，请点击“显示到屏幕”重试。',
        )
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
      setMessage('便签已保存在本机，点击“显示到屏幕”即可展示。')
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
        : category === 'online'
          ? c.kind === 'x' || c.kind === 'meme' || c.kind === 'news'
          : c.kind === category,
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
  const number = (
    name:
      | 'minLikes'
      | 'memeMinUps'
      | 'pollMinutes'
      | 'gapMinutes'
      | 'dailyLimit'
      | 'dailyRequestLimit'
      | 'displayMinutes'
      | 'quietStart'
      | 'quietEnd',
    label: string,
    min: number,
    max: number,
  ) => (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={draft[name]}
        onChange={(e) => edit(name, Number(e.target.value))}
      />
    </label>
  )
  return (
    <section
      className={'ambient-panel' + (dragging ? ' is-dragging' : '')}
      aria-labelledby="ambient-title"
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
      <div className="ambient-heading">
        <div>
          <span className="ambient-eyebrow">MULTIMEDIA</span>
          <h3 id="ambient-title">多媒体玩法</h3>
        </div>
        <div className="ambient-import-action">
          <span>图片拖进此页即可展示</span>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg"
            hidden
            onChange={(e) => void importFile(e.target.files?.[0])}
          />
          <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>
            选择图片
          </button>
        </div>
      </div>
      <p className="ambient-description">
        一张图片，一个新概念，或一条值得瞥一眼的动态。手动随时选，自动偶尔看；授权与异常提醒优先。
      </p>
      <div className="product-config-grid ambient-workbench">
        <div className="ambient-preview-column">
          <div className="ambient-library-tabs" aria-label="内容分类">
            {(
              [
                ['concept', '概念卡'],
                ['prompt', '思考实验'],
                ['local', '我的图片与便签'],
                ['online', '热点与 meme'],
                ['pet', '像素宠物'],
              ] as const
            ).map(([id, label]) => (
              <button
                type="button"
                key={id}
                aria-pressed={category === id}
                onClick={() => {
                  setCategory(id)
                  setSelectedId('')
                  setPreview(undefined)
                }}
              >
                {label}
              </button>
            ))}
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
          {category !== 'pet' && selectedCard && (
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
              <button type="button" disabled={busy} onClick={() => void showPreview(selectedCard)}>
                预览画面
              </button>
            </div>
          )}
          <section className="product-preview-stage">
            <div className="product-preview-label">
              <span>{preview ? '内容示例' : '当前目标画面'}</span>
              {preview && (
                <button
                  type="button"
                  className="product-button"
                  onClick={() => setPreview(undefined)}
                >
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
              <p className="product-empty">
                {targetError ? '预览暂不可用，等待设备服务连接。' : '正在读取当前画面…'}
              </p>
            )}
            {targetError && target && !preview && (
              <p className="product-caption" role="status">
                连接暂时中断，当前显示最后收到的目标画面。
              </p>
            )}
            <p className="ambient-message" data-feedback="content" role="status">
              {messageScope === 'content' ? message : ''}
            </p>
            <div className="ambient-display-actions">
              <button
                type="button"
                className="ambient-primary"
                disabled={busy || !selectedCard}
                onClick={() =>
                  selectedCard &&
                  void action(async () => {
                    const state = await window.codepulse.showAmbient(selectedCard.id)
                    setPreview(undefined)
                    return state
                  }, '已设为目标画面，联网屏幕会在当前刷新结束后获取。')
                }
              >
                显示到屏幕
              </button>
              <button
                type="button"
                disabled={busy || !snapshot?.activeId}
                onClick={() =>
                  void action(async () => {
                    const state = await window.codepulse.dismissAmbient()
                    setPreview(undefined)
                    return state
                  }, '已恢复工作目标画面。')
                }
              >
                回到工作画面
              </button>
              <span>手动展示 · {snapshot?.config.displayMinutes ?? 10} 分钟</span>
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
              <button type="button" disabled={busy || !note.trim()} onClick={() => void addNote()}>
                保存并预览
              </button>
              <small>{note.length} / 120 · 最近 8 张个人内容</small>
            </div>
          )}
          <h4 className="ambient-candidates-title">
            可选内容{' '}
            <small>
              预览只在电脑上；显示到屏幕后停留 {snapshot?.config.displayMinutes ?? 10} 分钟
            </small>
          </h4>
          <div className="ambient-cards">
            {!visibleCards.length && (
              <p className="ambient-empty">暂时没有合适内容。屏幕继续显示工作状态与用量。</p>
            )}
            {(selectedCard ? [selectedCard] : []).map((card) => (
              <article className="ambient-card" key={card.id}>
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
                {card.pet && (
                  <p className="ambient-hint">
                    此刻心情：{petMoodLabel(card.pet.mood).label}（
                    {petMoodLabel(card.pet.mood).hint}
                    ）。心情随工作状态和本地时间变化，选好形象后可随时手动展示。
                    自动推送只在允许展示的时段出场：安静时段和 Agent
                    工作时不会推送（可在“展示节奏”里调整），
                    所以“犯困”“陪你干活”多半只在手动展示时看到。屏幕上的红色需要完整刷新，约 16
                    秒并会闪一下， 所以宠物只在展示和退场时刷新两次。
                  </p>
                )}
                <div className="ambient-actions">
                  {card.url && (
                    <button
                      type="button"
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
        <aside className="product-config ambient-configuration">
          <h2>自动推送设置</h2>
          <fieldset disabled={busy || !snapshot}>
            <label className="ambient-toggle">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => edit('enabled', e.target.checked)}
              />
              自动推送（手动展示无需开启）
            </label>
            <div className="ambient-status" role="status">
              <span>
                {snapshot?.activeId
                  ? '内容已设为目标画面'
                  : snapshot?.pausedReason || '等待下一次展示机会'}
              </span>
              <span>
                今日 {snapshot?.shownToday ?? 0} / {snapshot?.config.dailyLimit ?? 6} 条
              </span>
            </div>
            <div className="ambient-local-options">
              <label className="ambient-toggle">
                <input
                  type="checkbox"
                  checked={draft.conceptsEnabled}
                  onChange={(e) => edit('conceptsEnabled', e.target.checked)}
                />{' '}
                概念卡 · 经济学 / 哲学 / 物理学
              </label>
              <label className="ambient-toggle">
                <input
                  type="checkbox"
                  checked={draft.promptsEnabled}
                  onChange={(e) => edit('promptsEnabled', e.target.checked)}
                />{' '}
                一分钟思考实验
              </label>
              <label className="ambient-toggle">
                <input
                  type="checkbox"
                  checked={draft.petEnabled}
                  onChange={(e) => edit('petEnabled', e.target.checked)}
                />{' '}
                像素宠物 · {petProfile(draft.petId).name}（在“像素宠物”页换形象）
              </label>
              <label className="ambient-toggle">
                <input
                  type="checkbox"
                  checked={draft.newsEnabled}
                  onChange={(e) => edit('newsEnabled', e.target.checked)}
                />{' '}
                科技热议 · Hacker News
              </label>
              <p className="ambient-hint">
                宠物按当前心情出场，同一形象同一心情每天最多一次，并遵守下方的展示节奏。概念与思考卡离线可用，原创短解读配阅读来源。科技热议只选近
                24 小时首页中超过 100 赞的标题，保留原文，不自动改写为新闻。
              </p>
            </div>
            <details className="ambient-details">
              <summary>X 贴文 · 来源与筛选</summary>
              <label className="ambient-toggle">
                <input
                  type="checkbox"
                  checked={draft.xEnabled}
                  onChange={(e) => edit('xEnabled', e.target.checked)}
                />
                订阅 X 贴文
              </label>
              <div className="ambient-fields">
                <label>
                  接入方式
                  <select
                    value={draft.provider}
                    onChange={(e) => edit('provider', e.target.value as AmbientConfig['provider'])}
                  >
                    <option value="twitterapi">TwitterAPI.io · 第三方按量付费</option>
                    <option value="x">X 官方 API · 按量付费</option>
                  </select>
                </label>
                <label>
                  API 密钥
                  <input
                    type="password"
                    autoComplete="off"
                    value={key}
                    placeholder={
                      snapshot?.hasKey && snapshot.config.provider === draft.provider
                        ? '已保存，留空保留'
                        : '填入对应来源的 API 密钥'
                    }
                    onChange={(e) => setKey(e.target.value)}
                  />
                </label>
              </div>
              <p className="ambient-hint">
                密钥通过系统加密保存在本机，API 费用由所选服务按量计收。这里展示指定账号的热门原帖。
              </p>
              <label className="ambient-wide">
                账号（逗号分隔）
                <input
                  value={draft.accounts.join(', ')}
                  onChange={(e) => edit('accounts', e.target.value.split(/[,，\s]+/))}
                />
              </label>
              <div className="ambient-fields">
                <label>
                  必须包含任一关键词（可留空）
                  <input
                    value={draft.keywords.join(', ')}
                    onChange={(e) =>
                      edit(
                        'keywords',
                        e.target.value.split(/[,，]/).map((s) => s.trimStart()),
                      )
                    }
                  />
                </label>
                <label>
                  排除关键词
                  <input
                    value={draft.exclude.join(', ')}
                    onChange={(e) =>
                      edit(
                        'exclude',
                        e.target.value.split(/[,，]/).map((s) => s.trimStart()),
                      )
                    }
                  />
                </label>
                {number('minLikes', '最低点赞数', 0, 1000000)}
                {number('dailyRequestLimit', '每天最多检查 X（含手动检查）', 1, 96)}
              </div>
              <p className="ambient-hint">
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
                    <label key={account}>
                      @{account} 最低赞数
                      <input
                        type="number"
                        min={0}
                        max={1000000}
                        value={draft.accountMinLikes[account.toLowerCase()] ?? draft.minLikes}
                        onChange={(e) =>
                          edit('accountMinLikes', {
                            ...draft.accountMinLikes,
                            [account.toLowerCase()]: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
              </details>
              <p className="ambient-hint">
                每次只读一页：第三方最多 20 条，官方最多 10 条。展示上限与 API
                费用不同，建议同时设置来源后台的消费上限。今日已检查 X{' '}
                {snapshot?.xRequestsToday ?? 0} 次。
              </p>
              <button
                type="button"
                disabled={busy || !snapshot?.hasKey}
                onClick={() =>
                  void action(
                    () => window.codepulse.setAmbientKey(draft.provider, ''),
                    '已清除该来源密钥',
                  )
                }
              >
                清除该来源密钥
              </button>
            </details>
            <details className="ambient-details">
              <summary>Meme · 少量高热度图片</summary>
              <label className="ambient-toggle">
                <input
                  type="checkbox"
                  checked={draft.memeEnabled}
                  onChange={(e) => edit('memeEnabled', e.target.checked)}
                />
                启用 meme
              </label>
              <div className="ambient-fields">
                <label>
                  来源
                  <select
                    value={draft.memeCommunity}
                    onChange={(e) =>
                      edit('memeCommunity', e.target.value as AmbientConfig['memeCommunity'])
                    }
                  >
                    <option value="memes">r/memes</option>
                    <option value="dankmemes">r/dankmemes</option>
                    <option value="ProgrammerHumor">r/ProgrammerHumor</option>
                  </select>
                </label>
                {number('memeMinUps', '最低赞数', 0, 1000000)}
              </div>
              <p className="ambient-hint">
                从公开来源一次取 20 个候选，再按赞数筛选；这是候选中的高赞内容，并非全站热榜。来自
                Reddit 的 PNG / JPEG
                图片，无需账号。保留原帖入口，自动适配黑白小屏；跳过成人内容、剧透、动图和超大图片；竖图保持比例并留白。
              </p>
            </details>
            <details className="ambient-details">
              <summary>展示节奏</summary>
              <label className="ambient-toggle">
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
                {number('displayMinutes', '每条停留（分钟）', 1, 30)}
                {number('quietStart', '安静时段开始（本地小时）', 0, 23)}
                {number('quietEnd', '安静时段结束（本地小时）', 0, 23)}
              </div>
              <p className="ambient-hint">
                起止小时相同表示不设安静时段。以上只限制自动推送；手动展示可跳过空闲、间隔与每日上限，也可暂时覆盖待查看；
                授权、补充输入及异常提醒仍优先。图片与便签只手动展示。
              </p>
            </details>
            <p className="ambient-message" data-feedback="settings" role="status">
              {messageScope === 'settings' ? message : ''}
            </p>
            <div className="ambient-actions">
              <button
                type="button"
                className="ambient-primary"
                disabled={busy || !snapshot}
                onClick={() =>
                  void action(
                    async () => {
                      if (key.trim()) {
                        await window.codepulse.setAmbientKey(draft.provider, key)
                        setKey('')
                      }
                      const s = await window.codepulse.setAmbient(draft)
                      savedConfig.current = normalizeAmbient(s.config)
                      setDraft(savedConfig.current)
                      return s
                    },
                    '自动推送设置已保存。展示选中内容请点左侧“显示到屏幕”。',
                    'settings',
                  )
                }
              >
                保存推送设置
              </button>
              <button
                type="button"
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
          </fieldset>
        </aside>
      </div>
    </section>
  )
}
