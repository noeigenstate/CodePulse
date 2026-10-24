import { useEffect, useState, type ReactNode } from 'react'
import type { ProductView, ShellSnapshot, StatusSnapshot } from '@codepulse/shared'
import { SurfaceControls } from './SurfaceControls.js'
import './product-shell.css'

export const PRODUCT_NAV: { id: ProductView; label: string; english: string; icon: string }[] = [
  { id: 'overview', label: '总览', english: 'Overview', icon: '◫' },
  { id: 'work', label: '工作', english: 'Work', icon: '⌁' },
  { id: 'usage', label: '用量', english: 'Usage', icon: '◔' },
  { id: 'ambient', label: '桌边内容', english: 'Desk content', icon: '▤' },
  { id: 'screen', label: '屏幕', english: 'Screen', icon: '▱' },
]
export function useProductNavigation() {
  const [shell, setShell] = useState<ShellSnapshot>()
  const [error, setError] = useState('')
  const [visited, setVisited] = useState(new Set<ProductView>(['overview']))
  useEffect(() => {
    let alive = true,
      received = false
    const accept = (state: ShellSnapshot) => {
      if (!alive) return
      setShell(state)
      setVisited((old) => new Set([...old, state.view]))
    }
    const stop = window.codepulse.onShell((s) => {
      received = true
      accept(s)
    })
    void window.codepulse
      .getShell()
      .then((s) => {
        if (!received) accept(s)
      })
      .catch(() => {
        if (alive) setError('产品导航暂不可用，请重启统一应用。')
      })
    return () => {
      alive = false
      stop()
    }
  }, [])
  const navigate = (view: ProductView) => {
    setError('')
    void window.codepulse.navigateProduct(view).catch(() => setError('导航偏好未保存，请重试。'))
  }
  return { view: shell?.view ?? 'overview', visited, navigate, error }
}
export function attentionCount(snapshot: StatusSnapshot): number {
  return snapshot.agents.filter(
    (a) =>
      !a.taskHidden &&
      (a.needPermission ||
        a.needUserInput ||
        ['WAITING_PERMISSION', 'WAITING_USER_INPUT', 'ERROR', 'TIMEOUT', 'USAGE_LIMITED'].includes(
          a.state,
        ) ||
        (a.state === 'DONE' && a.unread)),
  ).length
}
export function ProductFrame({
  view,
  navigate,
  locale,
  onLocale,
  onSettings,
  snapshot,
  children,
  error,
}: {
  view: ProductView
  navigate: (view: ProductView) => void
  locale: string
  onLocale: () => void
  onSettings: () => void
  snapshot: StatusSnapshot
  children: ReactNode
  error: string
}): JSX.Element {
  const zh = locale === 'zh',
    attention = attentionCount(snapshot)
  return (
    <div className="product-frame">
      <aside className="product-rail">
        <div className="product-brand">
          CodePulse<small>{zh ? '桌边信息终端' : 'DESK COMPANION'}</small>
        </div>
        <nav aria-label={zh ? '主导航' : 'Main navigation'}>
          {PRODUCT_NAV.map((item) => (
            <button
              type="button"
              key={item.id}
              aria-current={view === item.id ? 'page' : undefined}
              data-view={item.id}
              onClick={() => navigate(item.id)}
            >
              <span className="product-nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              {zh ? item.label : item.english}
            </button>
          ))}
        </nav>
        <div className="product-rail-footer">
          <button type="button" onClick={onLocale}>
            {zh ? '中 / EN' : 'EN / 中'}
          </button>
          <button type="button" aria-label={zh ? '设置' : 'Settings'} onClick={onSettings}>
            {zh ? '设置' : 'Settings'}
          </button>
        </div>
      </aside>
      <div className="product-main">
        <div className="product-topbar">
          <span>
            {zh ? '桌面端 · 与墨水屏共享内容' : 'Desktop · shared with your e-paper screen'}
          </span>
          <SurfaceControls locale={locale} />
        </div>
        {attention > 0 && view !== 'work' && (
          <div className="product-attention" role="status">
            <span>{zh ? `${attention} 项工作需要关注` : `${attention} items need attention`}</span>
            <button type="button" onClick={() => navigate('work')}>
              {zh ? '查看工作' : 'View work'}
            </button>
          </div>
        )}
        {error && (
          <p className="product-attention" role="alert">
            {error}
          </p>
        )}
        <main className="product-content">{children}</main>
      </div>
    </div>
  )
}
export function ProductOverview({
  snapshot,
  navigate,
  locale,
}: {
  snapshot: StatusSnapshot
  navigate: (view: ProductView) => void
  locale: string
}): JSX.Element {
  const zh = locale === 'zh'
  const visible = snapshot.agents.filter((a) => !a.taskHidden)
  const running = visible.filter((a) =>
    ['PROMPT_SUBMITTED', 'THINKING', 'TOOL_RUNNING'].includes(a.state),
  ).length
  const tasks = visible.filter((a) => a.externalSessionId || a.workspacePath).length
  const cards: { view: ProductView; title: string; body: string; action: string }[] = zh
    ? [
        {
          view: 'work',
          title: '留意工作进展',
          body: '查看 Agent 任务、等待输入和完成提醒。',
          action: '打开工作 →',
        },
        {
          view: 'usage',
          title: '掌握资源余量',
          body: '账户额度、重置时间与历史用量，沿用已有记录。',
          action: '查看用量 →',
        },
        {
          view: 'ambient',
          title: '偶尔看看世界',
          body: '少量 X 动态与 meme。来源、门槛和节奏由你决定。',
          action: '管理桌边内容 →',
        },
        {
          view: 'screen',
          title: '让内容待在身边',
          body: '设置常驻画面，连接墨水屏，或将屏幕独立放在副屏。',
          action: '进入屏幕工作台 →',
        },
      ]
    : [
        {
          view: 'work',
          title: 'Keep work in sight',
          body: 'Agent tasks, input requests and completion updates.',
          action: 'Open work →',
        },
        {
          view: 'usage',
          title: 'Know what remains',
          body: 'Account allowances, reset times and your existing usage history.',
          action: 'View usage →',
        },
        {
          view: 'ambient',
          title: 'A little outside perspective',
          body: 'Occasional X posts and memes, with your sources and rules.',
          action: 'Manage content →',
        },
        {
          view: 'screen',
          title: 'Keep it beside you',
          body: 'A shared display for your e-paper device or another desktop window.',
          action: 'Open screen →',
        },
      ]
  return (
    <div className="product-scroll">
      <header className="workspace-heading">
        <div>
          <span className="product-eyebrow">YOUR DESK, IN VIEW</span>
          <h1>{zh ? '需要时看一眼。' : 'A glance when it matters.'}</h1>
          <p>
            {zh
              ? '工作、余量与一点有趣的东西，都在身边。'
              : 'Work, resources and a little curiosity, beside you.'}
          </p>
        </div>
      </header>
      <div className="product-overview-stats">
        {[
          [zh ? '正在进行' : 'Running', running],
          [zh ? '需要关注' : 'Needs attention', attentionCount(snapshot)],
          [zh ? '可见任务' : 'Visible tasks', tasks],
        ].map(([label, value]) => (
          <div className="product-stat" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="product-launch-grid">
        {cards.map((c) => (
          <button
            className="product-launch-card"
            type="button"
            key={c.view}
            onClick={() => navigate(c.view)}
          >
            <strong>{c.title}</strong>
            <p>{c.body}</p>
            <small>{c.action}</small>
          </button>
        ))}
      </div>
    </div>
  )
}
