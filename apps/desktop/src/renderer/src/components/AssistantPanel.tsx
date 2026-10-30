import { useEffect, useRef, useState } from 'react'
import type {
  AssistantDraft,
  AssistantSecret,
  AssistantSettings,
  AssistantSnapshot,
  DeskTask,
} from '@codepulse/shared'
import { recordDeskVoice, playDeskVoice, type DeskRecording } from '../lib/assistantAudio.js'
import './assistant-panel.css'

export function AssistantPanel({ active }: { active: boolean }): JSX.Element {
  const [snapshot, setSnapshot] = useState<AssistantSnapshot>(),
    [error, setError] = useState(''),
    [working, setWorking] = useState(false)
  const [message, setMessage] = useState('')
  const [title, setTitle] = useState(''),
    [notes, setNotes] = useState(''),
    [due, setDue] = useState(''),
    [edit, setEdit] = useState<string>()
  const [input, setInput] = useState(''),
    [draft, setDraft] = useState<AssistantDraft>(),
    [filter, setFilter] = useState<'pending' | 'completed'>('pending')
  const [recording, setRecording] = useState(false),
    [keyField, setKeyField] = useState<AssistantSecret>('llmKey'),
    [key, setKey] = useState('')
  const [settings, setSettings] = useState<AssistantSettings>(),
    [settingsDirty, setSettingsDirty] = useState(false)
  const capture = useRef<DeskRecording>(),
    playback = useRef<() => void>(),
    alive = useRef(true),
    visible = useRef(active)
  const startingCapture = useRef(false)
  const audioAllowed = useRef({ input: false, output: false })
  audioAllowed.current = {
    input: Boolean(snapshot?.settings.voiceInput),
    output: Boolean(snapshot?.settings.voiceOutput),
  }
  const shownProposal = useRef<string>()
  visible.current = active
  useEffect(() => {
    alive.current = true
    const accept = (s: AssistantSnapshot) => {
      if (alive.current) setSnapshot(s)
    }
    const stop = window.codepulse.onAssistant(accept)
    void window.codepulse
      .getAssistant()
      .then(accept)
      .catch(() => setError('待办服务暂不可用，请检查本地存储或重启客户端。'))
    return () => {
      alive.current = false
      stop()
      capture.current?.cancel()
      playback.current?.()
    }
  }, [])
  useEffect(() => {
    if (snapshot && !settingsDirty) setSettings(snapshot.settings)
  }, [snapshot, settingsDirty])
  useEffect(() => {
    if (snapshot?.proposal && snapshot.proposal.id !== shownProposal.current) {
      shownProposal.current = snapshot.proposal.id
      setDraft(snapshot.proposal)
    }
    if (snapshot && !snapshot.proposal) setDraft(undefined)
  }, [snapshot])
  useEffect(() => {
    if (!active) {
      capture.current?.cancel()
      capture.current = undefined
      setRecording(false)
      playback.current?.()
    }
  }, [active])
  useEffect(() => {
    if (!snapshot?.settings.voiceInput) {
      capture.current?.cancel()
      capture.current = undefined
      setRecording(false)
    }
    if (!snapshot?.settings.voiceOutput) playback.current?.()
  }, [snapshot?.settings.voiceInput, snapshot?.settings.voiceOutput])
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (working) return
    setWorking(true)
    setError('')
    try {
      return await fn()
    } catch (e) {
      if (alive.current) setError(cleanError(e))
      return undefined
    } finally {
      if (alive.current) setWorking(false)
    }
  }
  const change = <K extends keyof AssistantSettings>(field: K, value: AssistantSettings[K]) => {
    if (settings) {
      setSettings({ ...settings, [field]: value })
      setSettingsDirty(true)
    }
  }
  const saveTask = () =>
    void run(async () => {
      const input = { title, notes, dueAt: due ? new Date(due).getTime() : null }
      const next = edit
        ? await window.codepulse.updateDeskTask(edit, input)
        : await window.codepulse.addDeskTask(input)
      setSnapshot(next)
      setTitle('')
      setNotes('')
      setDue('')
      setEdit(undefined)
    })
  const editTask = (task: DeskTask) => {
    setEdit(task.id)
    setTitle(task.title)
    setNotes(task.notes)
    if (task.dueAt) {
      const date = new Date(task.dueAt)
      setDue(new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16))
    } else setDue('')
  }
  const stopRecording = async () => {
    const current = capture.current
    if (!current) return
    capture.current = undefined
    setRecording(false)
    const pcm = await current.stop()
    if (!visible.current) return
    await run(async () => {
      const result = await window.codepulse.listenAssistant(pcm)
      if (alive.current) {
        setInput(result.text)
        setDraft(result.draft)
      }
    })
  }
  const toggleRecording = async () => {
    if (startingCapture.current) return
    if (recording) {
      await stopRecording()
      return
    }
    startingCapture.current = true
    setError('')
    try {
      const current = await recordDeskVoice(
        () => {
          void stopRecording().catch(() => setError('录音处理失败，请重试'))
        },
        () => visible.current && alive.current && audioAllowed.current.input,
      )
      if (!alive.current || !visible.current) {
        current.cancel()
        return
      }
      capture.current = current
      setRecording(true)
    } catch {
      setError('麦克风无法使用，请检查系统权限和录音设备。')
    } finally {
      startingCapture.current = false
    }
  }
  const speak = (value: string) =>
    void run(async () => {
      playback.current?.()
      const audio = await window.codepulse.speakAssistant(value.slice(0, 300))
      if (visible.current)
        playback.current = await playDeskVoice(
          audio.pcm,
          () => visible.current && alive.current && audioAllowed.current.output,
        )
    })
  const tasks =
    snapshot?.tasks.filter((t) =>
      filter === 'pending' ? t.status === 'pending' : t.status !== 'pending',
    ) ?? []
  return (
    <div className="desk-assistant">
      <header className="desk-assistant-heading">
        <div>
          <h1>待办与助手</h1>
          <p role="status">{message || '记下要做的事，让提醒留在桌边。数据保存在这台电脑。'}</p>
        </div>
        <div className="desk-assistant-actions">
          <button
            disabled={!snapshot || working}
            onClick={() =>
              void run(async () => {
                await window.codepulse.showDeskTasksOnInk()
                setMessage('已设为待办目标，停留 15 分钟；工作紧急提醒优先。')
              })
            }
          >
            显示到墨水屏
          </button>
          <button
            disabled={!snapshot || working}
            onClick={() =>
              void run(async () => {
                await window.codepulse.openSurface('standard', 'control')
                await window.codepulse.setPresentationTarget('ink')
              })
            }
          >
            常驻与轮播配置
          </button>
          <button
            disabled={!snapshot || working}
            onClick={() =>
              void run(async () => {
                await window.codepulse.hideDeskTasksOnInk()
                setMessage('已返回工作目标画面，实体屏以设备刷新结果为准。')
              })
            }
          >
            回到工作画面
          </button>
        </div>
      </header>
      {error && (
        <p className="desk-assistant-error" role="alert">
          {error}
        </p>
      )}
      <div className="desk-assistant-columns">
        <section className="desk-assistant-card" aria-label="待办列表">
          <div className="desk-assistant-card-title">
            <h2>我的待办</h2>
            <span>
              {snapshot?.tasks.filter((t) => t.status === 'pending').length ?? 0} 项待完成
            </span>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              saveTask()
            }}
            className="desk-task-form"
          >
            <label>
              要做什么
              <input
                maxLength={160}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="例如：整理今天的课堂反馈"
                required
              />
            </label>
            <div className="desk-task-form-row">
              <label>
                提醒时间 <small>可留空</small>
                <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
              </label>
              <button className="primary" disabled={working || !snapshot || !title.trim()}>
                {edit ? '保存修改' : '添加待办'}
              </button>
            </div>
            <label>
              备注
              <textarea
                rows={2}
                value={notes}
                maxLength={2000}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="需要保留的细节（可选）"
              />
            </label>
            {edit && (
              <button
                type="button"
                onClick={() => {
                  setEdit(undefined)
                  setTitle('')
                  setNotes('')
                  setDue('')
                }}
              >
                取消编辑
              </button>
            )}
          </form>
          <div className="desk-task-filters" role="group" aria-label="待办筛选">
            <button aria-pressed={filter === 'pending'} onClick={() => setFilter('pending')}>
              待完成
            </button>
            <button aria-pressed={filter === 'completed'} onClick={() => setFilter('completed')}>
              已完成与取消
            </button>
          </div>
          <div className="desk-task-list">
            {!snapshot ? (
              <p>正在打开本地待办…</p>
            ) : !tasks.length ? (
              <p className="desk-assistant-muted">
                {filter === 'pending'
                  ? '暂时没有待办，给今天留一点空白。'
                  : '完成的事项会保留在这里。'}
              </p>
            ) : (
              tasks.map((task) => (
                <article
                  key={task.id}
                  className={`desk-task ${task.status !== 'pending' ? 'is-done' : ''}`}
                >
                  <div className="desk-task-title">
                    <strong>{task.title}</strong>
                    {task.status === 'pending' && (
                      <button
                        disabled={working}
                        onClick={() => void run(() => window.codepulse.completeDeskTask(task.id))}
                      >
                        完成
                      </button>
                    )}
                  </div>
                  {task.notes && <p>{task.notes}</p>}
                  <small>
                    {task.dueAt ? new Date(task.dueAt).toLocaleString() : '未设置提醒'}
                    {task.reminderState === 'expired'
                      ? ' · 已错过提醒，待办仍保留'
                      : task.reminderState === 'delivered'
                        ? ' · 已投递提醒'
                        : ''}
                  </small>
                  {task.status === 'pending' && (
                    <div className="desk-task-buttons">
                      <button disabled={working} onClick={() => editTask(task)}>
                        编辑
                      </button>
                      {task.dueAt && (
                        <button
                          disabled={working}
                          onClick={() =>
                            void run(() => window.codepulse.snoozeDeskTask(task.id, 600))
                          }
                        >
                          10 分钟后提醒
                        </button>
                      )}
                      <button
                        disabled={working}
                        onClick={() => void run(() => window.codepulse.cancelDeskTask(task.id))}
                      >
                        取消待办
                      </button>
                    </div>
                  )}
                </article>
              ))
            )}
          </div>
        </section>
        <section className="desk-assistant-card" aria-label="文字与语音助手">
          <div className="desk-assistant-card-title">
            <h2>说一句，或写下来</h2>
            <span>{snapshot?.credentials.llmKey ? 'AI 已配置' : '本地规则可用'}</span>
          </div>
          <p className="desk-assistant-muted">
            例如“10分钟后提醒我喝水”。AI 提出的修改会先列出来，确认后保存。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void run(async () => setDraft(await window.codepulse.interpretAssistant(input)))
            }}
          >
            <textarea
              className="desk-assistant-prompt"
              rows={5}
              value={input}
              maxLength={4000}
              onChange={(e) => setInput(e.target.value)}
              placeholder="待办：读完这一章，或者描述你想安排的事情"
            />
            <div className="desk-assistant-actions">
              <button
                className="primary"
                disabled={!snapshot || working || snapshot.busy || !input.trim() || recording}
              >
                {working || snapshot?.busy ? '正在处理…' : '交给助手'}
              </button>
              <button
                type="button"
                disabled={working || !snapshot?.settings.voiceInput}
                aria-pressed={recording}
                onClick={() => void toggleRecording().catch(() => setError('录音处理失败，请重试'))}
              >
                {recording ? '结束录音' : '开始录音'}
              </button>
            </div>
          </form>
          {recording && <p role="status">正在录音，最长 25 秒。离开本页会取消录音。</p>}
          {draft && (
            <div className="desk-assistant-draft">
              <p>{draft.reply}</p>
              {draft.tasks.map((task, i) => (
                <div key={i} className="desk-draft-task">
                  <strong>{task.title}</strong>
                  <small>
                    {task.dueAt ? new Date(task.dueAt).toLocaleString() : '仅添加待办，不设置提醒'}
                  </small>
                </div>
              ))}
              {draft.actions
                .filter((a) => a.kind !== 'create_task')
                .map((action, i) => (
                  <p key={i}>
                    {action.kind === 'save_memory'
                      ? `记住：${action.text}`
                      : action.kind === 'switch_scene'
                        ? `切换场景：${{ general_assistant: '桌边助手', teacher_work: '教师办公', family_reading: '家庭阅读' }[action.scene]}`
                        : action.kind === 'complete_task'
                          ? `完成：${snapshot?.tasks.find((t) => t.id === action.id)?.title ?? '事项'}`
                          : `延后：${snapshot?.tasks.find((t) => t.id === action.id)?.title ?? '事项'}`}
                  </p>
                ))}
              <div className="desk-assistant-actions">
                {draft.actions.length > 0 && (
                  <button
                    className="primary"
                    disabled={working}
                    onClick={() =>
                      void run(async () => {
                        setSnapshot(await window.codepulse.applyAssistantDraft(draft.id))
                        setDraft(undefined)
                      })
                    }
                  >
                    确认执行
                  </button>
                )}
                <button onClick={() => setDraft(undefined)}>关闭建议</button>
                <button
                  disabled={working || !snapshot?.settings.voiceOutput}
                  onClick={() => speak(draft.reply)}
                >
                  朗读
                </button>
              </div>
            </div>
          )}
          <details className="desk-assistant-memories">
            <summary>记住的事情 · {snapshot?.memories.length ?? 0}</summary>
            {snapshot?.memories.map((memory) => (
              <div key={memory.id}>
                <p>{memory.text}</p>
                <button
                  disabled={working}
                  onClick={() => void run(() => window.codepulse.forgetDeskMemory(memory.id))}
                >
                  忘记
                </button>
              </div>
            ))}
          </details>
          <p className="desk-assistant-muted">
            语音只在你点击录音后采集。识别会发送本次录音；AI
            会发送输入、近期对话和部分待办与记忆至所选服务商。普通待办无需联网。
          </p>
        </section>
      </div>
      <details className="desk-assistant-card desk-assistant-settings">
        <summary>助手、语音与提醒设置</summary>
        {settings && snapshot && (
          <>
            <div className="desk-assistant-settings-grid">
              <label>
                使用场景
                <select
                  value={settings.scene}
                  onChange={(e) => change('scene', e.target.value as AssistantSettings['scene'])}
                >
                  <option value="general_assistant">桌边助手</option>
                  <option value="teacher_work">教师办公</option>
                  <option value="family_reading">家庭阅读</option>
                </select>
              </label>
              <label>
                AI 服务
                <select
                  value={settings.provider}
                  onChange={(e) => {
                    const provider = e.target.value as AssistantSettings['provider']
                    setSettings({
                      ...settings,
                      provider,
                      model: provider === 'glm' ? 'glm-4-flash' : 'qwen-plus',
                    })
                    setSettingsDirty(true)
                  }}
                >
                  <option value="tongyi">通义千问</option>
                  <option value="glm">智谱 GLM</option>
                </select>
              </label>
              <label>
                模型
                <input
                  value={settings.model}
                  maxLength={80}
                  onChange={(e) => change('model', e.target.value)}
                />
              </label>
              <label>
                语音音色
                <input
                  value={settings.voice}
                  maxLength={50}
                  onChange={(e) => change('voice', e.target.value)}
                />
              </label>
              <label>
                安静时段开始
                <select
                  value={settings.quietStart}
                  onChange={(e) => change('quietStart', Number(e.target.value))}
                >
                  {hours()}
                </select>
              </label>
              <label>
                安静时段结束
                <select
                  value={settings.quietEnd}
                  onChange={(e) => change('quietEnd', Number(e.target.value))}
                >
                  {hours()}
                </select>
              </label>
            </div>
            <div className="desk-assistant-checks">
              {(
                [
                  ['notifications', '桌面到期提醒'],
                  ['voiceInput', '语音输入'],
                  ['voiceOutput', '语音输出'],
                ] as const
              ).map(([field, label]) => (
                <label key={field}>
                  <input
                    type="checkbox"
                    checked={settings[field]}
                    onChange={(e) => change(field, e.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <p className="desk-assistant-muted">
              安静时段不播报；超过 30
              分钟的旧提醒不补报，事项仍留在列表。起止时间相同表示不设置安静时段。电脑休眠或客户端退出时无法即时提醒。
            </p>
            <button
              className="primary"
              disabled={working || !settingsDirty}
              onClick={() =>
                void run(async () => {
                  setSnapshot(await window.codepulse.configureAssistant(settings))
                  setSettingsDirty(false)
                })
              }
            >
              保存设置
            </button>
            <div className="desk-assistant-keys">
              <label>
                凭据
                <select
                  value={keyField}
                  onChange={(e) => {
                    setKeyField(e.target.value as AssistantSecret)
                    setKey('')
                  }}
                >
                  <option value="llmKey">AI API Key</option>
                  <option value="speechAppKey">阿里语音 Appkey</option>
                  <option value="speechToken">阿里语音 NLS Token</option>
                </select>
              </label>
              <label>
                {snapshot.credentials[keyField] ? '已配置，填入新值可替换' : '尚未配置'}
                <input
                  type="password"
                  autoComplete="new-password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  maxLength={4096}
                />
              </label>
              <button
                disabled={working || settingsDirty || !key.trim()}
                onClick={() =>
                  void run(async () => {
                    setSnapshot(await window.codepulse.setAssistantKey(keyField, key))
                    setKey('')
                  })
                }
              >
                加密保存
              </button>
              <button
                disabled={working || settingsDirty || !snapshot.credentials[keyField]}
                onClick={() =>
                  void run(async () => {
                    setSnapshot(await window.codepulse.setAssistantKey(keyField, ''))
                    setKey('')
                  })
                }
              >
                清除
              </button>
            </div>
            <p className="desk-assistant-muted">
              请先保存所选 AI
              服务，再保存对应凭据。凭据仅在系统加密存储可用时保存，不回传给界面。NLS Token
              有有效期，过期后需更新。新板尚需核对麦克风、功放和接线，打开此处开关不会自动启用未知的硬件引脚。
            </p>
          </>
        )}
      </details>
    </div>
  )
}
function hours() {
  return Array.from({ length: 24 }, (_, h) => (
    <option key={h} value={h}>
      {String(h).padStart(2, '0')}:00
    </option>
  ))
}
function cleanError(error: unknown): string {
  const value = error instanceof Error ? error.message : ''
  const message = value.replace(/^Error invoking remote method '[^']+': Error: /, '')
  return /^[\u3400-\u9fff]/.test(message) && message.length <= 200
    ? message
    : '操作未完成，请检查输入后重试。'
}
