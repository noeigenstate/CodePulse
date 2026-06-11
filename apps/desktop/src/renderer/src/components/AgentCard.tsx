/**
 * 每个 agent 的 Dashboard 卡片：状态徽标、项目/模型/耗时/工具调用数、
 * 当前活动、上下文使用进度条、最后一条助手消息，
 * 以及存在未读结果时的确认按钮。
 *
 * @module renderer/components/AgentCard
 */
import { TOKEN_QUOTA_WINDOW_LABEL, type AgentRuntimeState } from '@codepulse/shared'
import {
  agentName,
  basename,
  formatDuration,
  formatPercent,
  formatRelative,
  formatTokens,
  turnStateStyle,
} from '../lib/format.js'

/**
 * {@link AgentCard} 的 props。
 */
interface Props {
  /** 要渲染的 agent 运行时状态。 */
  agent: AgentRuntimeState
  /** 当前时间（epoch 毫秒），用于实时时长。 */
  now: number
  /** 用户确认未读结果时调用。 */
  onAck: () => void
}

/**
 * 渲染单个 agent 的状态卡片。
 *
 * @param props 见 {@link Props}。
 * @returns 卡片元素。
 */
export function AgentCard({ agent, now, onAck }: Props): JSX.Element {
  const style = turnStateStyle(agent.state)
  const tok = agent.token
  const ctx = tok?.contextUsedPercent
  const hasTokens = tok != null && (tok.input != null || tok.output != null || tok.total != null)
  const elapsed = agent.turnStartedAt ? formatDuration(now - agent.turnStartedAt) : null
  const pct = typeof ctx === 'number' ? Math.min(100, Math.max(0, ctx)) : null

  return (
    <article className="liquid-glass rounded-2xl p-5 transition duration-200 hover:border-cyan-200/30">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <div className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-cyan-200/15 bg-cyan-300/10">
            <span className={`h-3 w-3 rounded-full ${style.dot}`} />
            <span className="absolute inset-2 rounded-xl border border-cyan-200/10" />
          </div>
          <div className="min-w-0">
            <p className="hud-label">Agent</p>
            <h2 className="truncate text-xl font-semibold tracking-tight text-gray-50">
              {agentName(agent.agentType)}
            </h2>
            <div className="mt-1 flex items-center gap-2 text-sm">
              <span className={style.text}>{style.label}</span>
              {agent.unread && <span className="text-xs text-emerald-300">新结果</span>}
            </div>
          </div>
        </div>
        {agent.unread && (
          <button
            onClick={onAck}
            className="rounded-lg border border-emerald-200/20 bg-emerald-300/10 px-2.5 py-1 text-xs text-emerald-100 transition hover:bg-emerald-300/20 active:translate-y-px"
          >
            标记已读
          </button>
        )}
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-2 text-sm">
        <Field label="项目" value={basename(agent.workspacePath)} />
        <Field label="模型" value={agent.model ?? '—'} />
        <Field label="本轮耗时" value={elapsed ?? '—'} />
        <Field label="工具调用" value={String(agent.toolCallCount)} />
      </dl>

      <div className="glass-subtle mt-4 rounded-xl px-3 py-3 text-sm leading-5 text-gray-300">
        <span className="mr-1 text-cyan-200/70">当前</span>
        {agent.activity ?? '等待事件'}
      </div>

      {(typeof ctx === 'number' || hasTokens || tok?.costUsd != null) && (
        <div className="mt-5">
          {typeof ctx === 'number' && (
            <>
              <div className="mb-1 flex justify-between text-xs text-gray-400">
                <span>Token / Context</span>
                <span>
                  {formatPercent(ctx)}
                  {tok?.costUsd != null && ` · $${tok.costUsd.toFixed(2)}`}
                </span>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-slate-950/70 ring-1 ring-white/10">
                <div
                  className={`neon-progress h-full rounded-full ${ctxColor(ctx)}`}
                  style={{ width: `${Math.max(2, pct ?? 0)}%` }}
                />
              </div>
            </>
          )}
          {hasTokens && (
            <div className="mt-2 flex justify-between text-xs text-gray-400">
              <span>{TOKEN_QUOTA_WINDOW_LABEL}</span>
              <span className="text-gray-300">
                ↑{formatTokens(tok?.input)} ↓{formatTokens(tok?.output)} · 共{' '}
                {formatTokens(tok?.total)}
              </span>
            </div>
          )}
          {typeof ctx === 'number' && (
            <p className="mt-1 text-[10px] text-gray-500">
              {TOKEN_QUOTA_WINDOW_LABEL}窗口以对应 CLI 的官方重置时间为准
            </p>
          )}
          {typeof ctx !== 'number' && tok?.costUsd != null && (
            <div className="mt-2 flex justify-between text-xs text-gray-400">
              <span>Cost</span>
              <span className="text-gray-300">${tok.costUsd.toFixed(2)}</span>
            </div>
          )}
        </div>
      )}

      {agent.lastAssistantMessage && (
        <p className="mt-4 line-clamp-3 text-sm text-gray-400">{agent.lastAssistantMessage}</p>
      )}

      <div className="mt-4 text-right text-xs text-gray-500">
        最近事件：{agent.lastEventAt ? formatRelative(agent.lastEventAt, now) : '—'}
      </div>
    </article>
  )
}

/**
 * 卡片明细网格中带标签的小字段。
 *
 * @param props.label 字段标签。
 * @param props.value 字段值。
 * @returns 字段元素。
 */
function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="glass-subtle rounded-xl px-3 py-2">
      <dt className="text-[10px] text-gray-500">{label}</dt>
      <dd className="mt-0.5 truncate text-gray-100">{value}</dd>
    </div>
  )
}

/**
 * 按使用率选择上下文进度条颜色：通常为蓝色，≥80% 黄色，≥95% 红色。
 *
 * @param pct 上下文已用百分比。
 * @returns 进度条的 Tailwind 背景类名。
 */
function ctxColor(pct: number): string {
  if (pct >= 95) return 'bg-red-500'
  if (pct >= 80) return 'bg-yellow-400'
  return 'bg-blue-400'
}
