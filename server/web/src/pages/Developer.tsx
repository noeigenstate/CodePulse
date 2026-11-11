import type { PluginKind, PluginSetting } from '@codepulse/shared'
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { api, type Developer as DeveloperInfo, type DevPlugin, type DevVersion } from '../api'
import { useAction, useAsync } from '../hooks'
import { devSession } from '../session'
import { LogoRow } from './LogoUpload'
import { Button, ErrorLine, Icon, State, type StateTone } from '../ui'

const versionState = (v: DevVersion, liveVersion: string | null): [string, StateTone] => {
  switch (v.state) {
    case 'approved':
      return v.version === liveVersion ? ['已上架', 'ok'] : ['旧版本', '']
    case 'pending':
      return ['待审核', 'wait']
    case 'rejected':
      return ['未通过', 'bad']
    default:
      return ['草稿', '']
  }
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  )
}

function AuthPanel() {
  const [registering, setRegistering] = useState(false)
  const { busy, error, run } = useAction()
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const field = (name: string) => String(form.get(name) ?? '')
    run(async () => {
      const { token } = registering
        ? await api.devRegister({
            email: field('email'),
            name: field('name'),
            password: field('password'),
          })
        : await api.devLogin({ email: field('email'), password: field('password') })
      devSession.set(token)
    })
  }
  return (
    <form className="panel auth" onSubmit={submit}>
      <div className="panel-head">
        <h2>{registering ? '注册开发者账号' : '登录开发者账号'}</h2>
        <button type="button" className="link" onClick={() => setRegistering(!registering)}>
          {registering ? '已有账号，去登录' : '没有账号，去注册'}
        </button>
      </div>
      <p className="hint">开发者可以提交插件，通过审核后上架。</p>
      <Field label="邮箱">
        {(id) => <input id={id} name="email" type="email" autoComplete="email" required />}
      </Field>
      {registering && (
        <Field label="名称">
          {(id) => <input id={id} name="name" autoComplete="nickname" required maxLength={40} />}
        </Field>
      )}
      <Field label="密码">
        {(id) => (
          <input
            id={id}
            name="password"
            type="password"
            autoComplete={registering ? 'new-password' : 'current-password'}
            required
            minLength={registering ? 8 : undefined}
            placeholder={registering ? '至少 8 位' : undefined}
          />
        )}
      </Field>
      <ErrorLine reason={error} />
      <div className="form-foot">
        <Button primary busy={busy} type="submit">
          {registering ? '注册' : '登录'}
        </Button>
      </div>
    </form>
  )
}

function SecretNotice({ secret, onDone }: { secret: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = () =>
    navigator.clipboard.writeText(secret).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  return (
    <div className="notice secret" role="status">
      <State tone="wait">只显示这一次</State>
      <div className="meta">Webhook 签名密钥，请立即保存；之后无法再查看。</div>
      <code>{secret}</code>
      <div className="actions">
        <Button compact onClick={copy}>
          {copied ? '已复制' : '复制'}
        </Button>
        <Button compact onClick={onDone}>
          我已保存
        </Button>
      </div>
    </div>
  )
}

function CreateForm({ onCreated }: { onCreated: (secret: string) => void }) {
  const { busy, error, run } = useAction()
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const data = new FormData(form)
    const field = (name: string) => String(data.get(name) ?? '')
    run(async () => {
      const { webhookSecret } = await api.createPlugin({
        id: field('id'),
        name: field('name'),
        summary: field('summary'),
      })
      form.reset()
      onCreated(webhookSecret)
    })
  }
  return (
    <form onSubmit={submit} className="inline-form">
      <Field label="插件 ID">
        {(id) => (
          <input
            id={id}
            name="id"
            required
            placeholder="dev.wordaday"
            pattern="[a-z0-9]+([.\-][a-z0-9]+)*"
            minLength={3}
            maxLength={40}
          />
        )}
      </Field>
      <Field label="名称">{(id) => <input id={id} name="name" required maxLength={40} />}</Field>
      <Field label="简介">
        {(id) => (
          <input id={id} name="summary" required maxLength={60} placeholder="一行，最多 60 字" />
        )}
      </Field>
      <ErrorLine reason={error} />
      <div className="form-foot">
        <Button primary busy={busy} type="submit">
          创建
        </Button>
      </div>
    </form>
  )
}

const PluginName = ({ plugin }: { plugin: DevPlugin }) => (
  <div className="who c-who">
    <Icon name={plugin.name} logoUrl={plugin.logoUrl} />
    <span>{plugin.name}</span>
  </div>
)

function MyPlugins({
  developer,
  plugins,
  reload,
}: {
  developer: DeveloperInfo
  plugins: DevPlugin[]
  reload: () => void
}) {
  const [creating, setCreating] = useState(false)
  const [secret, setSecret] = useState('')
  const logout = useAction()
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>我的插件</h2>
        <div className="actions">
          <button
            type="button"
            className="link"
            disabled={logout.busy}
            onClick={() => logout.run(() => api.devLogout().finally(devSession.clear))}
          >
            {logout.busy ? '…' : '退出'}
          </button>
          <Button compact onClick={() => setCreating(!creating)}>
            新建插件
          </Button>
        </div>
      </div>
      <p className="hint">{`已登录 ${developer.email}`}</p>
      {secret && <SecretNotice secret={secret} onDone={() => setSecret('')} />}
      {creating && (
        <CreateForm
          onCreated={(s) => {
            setSecret(s)
            setCreating(false)
            reload()
          }}
        />
      )}
      {plugins.length > 0 && (
        <section aria-label="插件图标">
          <h3 className="panel-sub">插件图标</h3>
          <p className="hint">
            PNG、JPEG 或 WebP，正方形，64–1024 像素，不超过 200 KB。上传后立即生效。
          </p>
          {plugins.map((p) => (
            <LogoRow key={p.id} plugin={p} onChanged={reload} />
          ))}
        </section>
      )}
      <h3 className="panel-sub">版本</h3>
      <div className="list dev" role="table" aria-label="我的插件">
        <div className="list-head meta" role="row">
          <span className="c-who">插件</span>
          <span className="c-time">版本</span>
          <span className="c-state">审核</span>
        </div>
        {plugins.length === 0 && (
          <div className="list-row">
            <span className="meta">还没有插件，先新建一个。</span>
          </div>
        )}
        {plugins.flatMap((p) =>
          p.versions.length === 0
            ? [
                <div key={p.id} className="list-row" role="row">
                  <PluginName plugin={p} />
                  <span className="meta c-time">—</span>
                  <div className="c-state meta">尚未提交版本</div>
                </div>,
              ]
            : p.versions.map((v) => {
                const [label, tone] = versionState(v, p.liveVersion)
                return (
                  <div key={v.id} className="list-row" role="row">
                    <PluginName plugin={p} />
                    <span className="meta c-time">{v.version}</span>
                    <div className="c-state">
                      <State tone={tone}>{label}</State>
                      {v.note && <div className="meta">{v.note}</div>}
                    </div>
                  </div>
                )
              }),
        )}
      </div>
    </div>
  )
}

function parseJson(label: string, text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(`${label}不是有效的 JSON：${(e as Error).message}`)
  }
}

function SubmitForm({ plugins, onSubmitted }: { plugins: DevPlugin[]; onSubmitted: () => void }) {
  const [pluginId, setPluginId] = useState('')
  const [kind, setKind] = useState<Exclude<PluginKind, 'builtin'>>('pack')
  const [version, setVersion] = useState('1.0.0')
  const [refreshMinutes, setRefreshMinutes] = useState(60)
  const [description, setDescription] = useState('')
  const [cards, setCards] = useState(
    '[\n  {"id":"w-001","source":"每日一词","text":"serendipity：意外发现美好事物的运气。"}\n]',
  )
  const [endpoint, setEndpoint] = useState('')
  const [settings, setSettings] = useState('[]')
  const test = useAction()
  const submit = useAction()
  const [result, setResult] = useState<{ count: number; error: string; lines: string[] } | null>(
    null,
  )

  // Falls back to the first plugin until the developer picks one (the list loads late).
  const plugin = plugins.find((p) => p.id === pluginId) ?? plugins[0]
  const draft = () => {
    if (!plugin) throw new Error('请先新建并选择一个插件')
    return {
      manifest: {
        id: plugin.id,
        version: version.trim(),
        name: plugin.name,
        summary: plugin.summary,
        description,
        kind,
        refreshMinutes,
        settings: parseJson('设置项', settings) as PluginSetting[],
      },
      ...(kind === 'pack'
        ? { cards: parseJson('卡片 JSON', cards) as unknown[] }
        : { endpoint: endpoint.trim() }),
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>提交新版本</h2>
      </div>
      <Field label="插件">
        {(id) => (
          <select id={id} value={plugin?.id ?? ''} onChange={(e) => setPluginId(e.target.value)}>
            {plugins.map((p) => (
              <option key={p.id} value={p.id}>
                {`${p.name}（${p.id}）`}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="版本">
        {(id) => (
          <input
            id={id}
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="1.0.0"
          />
        )}
      </Field>
      <Field label="类型">
        {(id) => (
          <select id={id} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="pack">内容包：上传卡片 JSON</option>
            <option value="webhook">Webhook：填写 HTTPS 接口</option>
          </select>
        )}
      </Field>
      <Field label="刷新间隔（分钟，15–1440）">
        {(id) => (
          <input
            id={id}
            type="number"
            min={15}
            max={1440}
            value={refreshMinutes}
            onChange={(e) => setRefreshMinutes(e.target.valueAsNumber)}
          />
        )}
      </Field>
      <Field label="说明">
        {(id) => (
          <textarea id={id} value={description} onChange={(e) => setDescription(e.target.value)} />
        )}
      </Field>
      {kind === 'pack' ? (
        <Field label="卡片 JSON">
          {(id) => <textarea id={id} value={cards} onChange={(e) => setCards(e.target.value)} />}
        </Field>
      ) : (
        <Field label="接口地址">
          {(id) => (
            <input
              id={id}
              type="url"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://example.com/codepulse/cards"
            />
          )}
        </Field>
      )}
      <details className="field">
        <summary>高级：设置项</summary>
        <Field label="设置项 JSON">
          {(id) => (
            <textarea id={id} value={settings} onChange={(e) => setSettings(e.target.value)} />
          )}
        </Field>
      </details>
      <ErrorLine reason={test.error || submit.error} />
      {result && (
        <div className="notice" role="status">
          {result.error ? (
            <>
              <State tone="bad">生成失败</State>
              <div className="meta">{result.error}</div>
            </>
          ) : (
            <>
              <State tone="ok">{`已生成 ${result.count} 张卡片，格式通过校验`}</State>
              <ol className="test-cards">
                {result.lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
      <div className="form-foot">
        <Button
          busy={test.busy}
          onClick={() =>
            test.run(async () => {
              setResult(null)
              const body = draft()
              const { cards, error } = await api.testPlugin(body.manifest.id, body)
              setResult({
                count: cards.length,
                error,
                lines: cards.map((c) => `${c.source}：${c.text}`),
              })
            })
          }
        >
          测试生成
        </Button>
        <Button
          primary
          busy={submit.busy}
          onClick={() =>
            submit.run(async () => {
              const body = draft()
              await api.submitVersion(body.manifest.id, body)
              setResult(null)
              onSubmitted()
            })
          }
        >
          提交审核
        </Button>
      </div>
    </div>
  )
}

export function Developer({
  developer,
  notify,
}: {
  /** `undefined` while a stored session is still being checked. */
  developer: DeveloperInfo | null | undefined
  notify: (message: string) => void
}) {
  const mine = useAsync(() => (developer ? api.devPlugins() : Promise.resolve([])), [developer])
  if (developer === undefined) return null
  if (!developer) return <AuthPanel />
  const plugins = mine.data ?? []
  return (
    <>
      <ErrorLine title="加载失败" reason={mine.error} />
      <section className="split">
        <MyPlugins developer={developer} plugins={plugins} reload={mine.reload} />
        <SubmitForm
          plugins={plugins}
          onSubmitted={() => {
            notify('已提交，等待审核')
            mine.reload()
          }}
        />
      </section>
    </>
  )
}
