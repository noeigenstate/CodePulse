/**
 * The per-agent Dashboard card: state badge, project/model/elapsed/tool-count,
 * current activity, a context-usage bar, the last assistant message, and an
 * acknowledge button when there is an unread result.
 *
 * @module renderer/components/AgentCard
 */
import type { AgentRuntimeState } from '@codepulse/shared'
import {
  agentName,
  basename,
  formatDuration,
  formatRelative,
  turnStateStyle,
} from '../lib/format.js'

/**
 * Props for {@link AgentCard}.
 */
interface Props {
  /** The agent's runtime state to render. */
  agent: AgentRuntimeState
  /** Current time in epoch millis, for live durations. */
  now: number
  /** Invoked when the user acknowledges an unread result. */
  onAck: () => void
}

/**
 * Renders one agent's status card.
 *
 * @param props See {@link Props}.
 * @returns The card element.
 */
export function AgentCard({ agent, now, onAck }: Props): JSX.Element {
  const style = turnStateStyle(agent.state)
  const ctx = agent.token?.contextUsedPercent
  const elapsed = agent.turnStartedAt ? formatDuration(now - agent.turnStartedAt) : null

  return (
    <div className="rounded-xl border border-ink-600/60 bg-ink-800/70 p-5 shadow-lg">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">{agentName(agent.agentType)}</h2>
          <div className="mt-1 flex items-center gap-2 text-sm">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${style.dot}`} />
            <span className={style.text}>{style.label}</span>
          </div>
        </div>
        {agent.unread && (
          <button
            onClick={onAck}
            className="rounded-md border border-ink-600 px-2.5 py-1 text-xs text-gray-300 transition hover:bg-ink-700"
          >
            标记已读
          </button>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <Field label="项目" value={basename(agent.workspacePath)} />
        <Field label="模型" value={agent.model ?? '—'} />
        <Field label="本轮耗时" value={elapsed ?? '—'} />
        <Field label="工具调用" value={String(agent.toolCallCount)} />
      </dl>

      <div className="mt-4 rounded-lg bg-ink-900/60 px-3 py-2 text-sm text-gray-300">
        <span className="text-gray-500">当前：</span>
        {agent.activity ?? '等待事件'}
      </div>

      {typeof ctx === 'number' && (
        <div className="mt-4">
          <div className="mb-1 flex justify-between text-xs text-gray-400">
            <span>Context</span>
            <span>
              {Math.round(ctx)}%{agent.token?.costUsd != null && ` · $${agent.token.costUsd.toFixed(2)}`}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-ink-600">
            <div
              className={`h-full rounded-full ${ctxColor(ctx)}`}
              style={{ width: `${Math.min(100, Math.max(2, ctx))}%` }}
            />
          </div>
        </div>
      )}

      {agent.lastAssistantMessage && (
        <p className="mt-4 line-clamp-3 text-sm text-gray-400">{agent.lastAssistantMessage}</p>
      )}

      <div className="mt-4 text-right text-xs text-gray-500">
        最近事件：{agent.lastEventAt ? formatRelative(agent.lastEventAt, now) : '—'}
      </div>
    </div>
  )
}

/**
 * A small labelled field used in the card's detail grid.
 *
 * @param props.label The field label.
 * @param props.value The field value.
 * @returns The field element.
 */
function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="truncate text-gray-200">{value}</dd>
    </div>
  )
}

/**
 * Chooses the context-bar colour by usage: blue normally, yellow ≥80%, red ≥95%.
 *
 * @param pct The context-used percentage.
 * @returns The Tailwind background class for the bar.
 */
function ctxColor(pct: number): string {
  if (pct >= 95) return 'bg-red-500'
  if (pct >= 80) return 'bg-yellow-400'
  return 'bg-blue-400'
}
