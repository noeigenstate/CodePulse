import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_AMBIENT,
  type AmbientCard,
  type AmbientConfig,
  type AmbientSnapshot,
  type DeviceStatusV1,
} from '@codepulse/shared'
import { DeviceScreenPreview } from './DeviceScreenPreview.js'
import './ambient-panel.css'

export function AmbientPanel(): JSX.Element {
  const [snapshot, setSnapshot] = useState<AmbientSnapshot>()
  const [draft, setDraft] = useState<AmbientConfig>({ ...DEFAULT_AMBIENT })
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
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
          savedConfig.current = s.config
          setDraft(s.config)
        }
      })
      .catch(() => {
        if (alive) setMessage('当前桌面服务尚未加载桌边动态，请重新启动统一应用。')
      })
    const stop = window.codepulse.onAmbient((s) => {
      received = true
      if (!alive) return
      setSnapshot(s)
      if (JSON.stringify(savedConfig.current) !== JSON.stringify(s.config)) {
        const dirty =
          savedConfig.current &&
          JSON.stringify(draftRef.current) !== JSON.stringify(savedConfig.current)
        savedConfig.current = s.config
        if (!dirty) setDraft(s.config)
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
  async function action(run: () => Promise<AmbientSnapshot>, success = '') {
    setBusy(true)
    setMessage('')
    try {
      const state = await run()
      setSnapshot(state)
      setMessage(success)
    } catch {
      setMessage('操作未完成，请检查来源连接或系统加密存储。')
    } finally {
      setBusy(false)
    }
  }
  async function showPreview(card: AmbientCard) {
    setBusy(true)
    try {
      setPreview(await window.codepulse.previewAmbient(card.id))
    } catch {
      setMessage('这条内容已过期，请刷新候选。')
    } finally {
      setBusy(false)
    }
  }
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
    <section className="ambient-panel" aria-labelledby="ambient-title">
      <div className="ambient-heading">
        <div>
          <span className="ambient-eyebrow">DESK EDITION</span>
          <h3 id="ambient-title">桌边动态</h3>
        </div>
        <span className="ambient-tag">偶尔看看</span>
      </div>
      <p className="ambient-description">
        几条值得瞥一眼的 X 动态，一张有意思的 meme。没有合适内容就留白，工作提醒始终优先。
      </p>
      <label className="ambient-toggle">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => edit('enabled', e.target.checked)}
        />
        启用桌边动态
      </label>
      <div className="ambient-status" role="status">
        <span>
          {snapshot?.pausedReason ||
            (snapshot?.activeId ? '正在展示一条动态' : '等待下一次展示机会')}
        </span>
        <span>
          今日 {snapshot?.shownToday ?? 0} / {snapshot?.config.dailyLimit ?? 6} 条
        </span>
      </div>
      <details className="ambient-details" open={!snapshot?.hasKey && draft.xEnabled}>
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
          费用不同，建议同时设置来源后台的消费上限。今日已检查 X {snapshot?.xRequestsToday ?? 0}{' '}
          次。
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
          来自 Reddit 的公开 PNG / JPEG
          图片，无需账号。保留原帖入口，自动适配黑白小屏；跳过成人内容、剧透、动图和过长、过窄的图片。
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
          起止小时相同表示不设安静时段。预览只在电脑上展示；「按规则展示」也遵守提醒优先、间隔和每日上限。
        </p>
      </details>
      <div className="ambient-actions">
        <button
          type="button"
          className="ambient-primary"
          disabled={busy || !snapshot}
          onClick={() =>
            void action(async () => {
              if (key.trim()) {
                await window.codepulse.setAmbientKey(draft.provider, key)
                setKey('')
              }
              const s = await window.codepulse.setAmbient(draft)
              setDraft(s.config)
              return s
            }, '设置已保存')
          }
        >
          保存设置
        </button>
        <button
          type="button"
          disabled={busy || !snapshot?.config.enabled || snapshot?.collecting}
          onClick={() => void action(() => window.codepulse.refreshAmbient())}
        >
          {snapshot?.collecting ? '正在检查…' : '检查新内容'}
        </button>
        <button
          type="button"
          disabled={busy || !snapshot?.activeId}
          onClick={() => void action(() => window.codepulse.dismissAmbient())}
        >
          回到工作画面
        </button>
      </div>
      {message && (
        <p className="ambient-message" role="status">
          {message}
        </p>
      )}
      <div className="ambient-health">
        <span>X：{snapshot?.sourceStatus.x ?? '正在连接'}</span>
        <span>Meme：{snapshot?.sourceStatus.meme ?? '正在连接'}</span>
        {Boolean(snapshot?.lastCheckedAt) && (
          <span>最近检查 {new Date(snapshot!.lastCheckedAt).toLocaleTimeString()}</span>
        )}
      </div>
      <div className="ambient-cards">
        {!snapshot?.cards.length && (
          <p className="ambient-empty">暂时没有合适内容。屏幕继续显示工作状态与用量。</p>
        )}
        {snapshot?.cards.map((card) => (
          <article className="ambient-card" key={card.id}>
            <div className="ambient-card-meta">
              <strong>{card.source}</strong>
              <span>
                {card.score.toLocaleString()} 赞 · {card.kind === 'meme' ? '采集于 ' : ''}
                {new Date(card.publishedAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>
            <p>{card.text}</p>
            <div className="ambient-actions">
              <button type="button" disabled={busy} onClick={() => void showPreview(card)}>
                预览画面
              </button>
              <button
                type="button"
                disabled={busy || Boolean(snapshot.pausedReason) || Boolean(snapshot.activeId)}
                onClick={() => void action(() => window.codepulse.showAmbient(card.id))}
              >
                按规则展示
              </button>
              <button
                type="button"
                onClick={() =>
                  void window.codepulse
                    .openAmbient(card.id)
                    .catch(() => setMessage('原帖暂时无法打开'))
                }
              >
                查看原帖 ↗
              </button>
            </div>
          </article>
        ))}
      </div>
      {preview && (
        <div className="ambient-preview">
          <div className="ambient-card-meta">
            <strong>屏幕预览 · 不改变设备</strong>
            <button type="button" onClick={() => setPreview(undefined)}>
              收起
            </button>
          </div>
          <DeviceScreenPreview status={preview} sample />
        </div>
      )}
    </section>
  )
}
