/**
 * 右侧通知栏：可滚动的最近通知列表，按严重级别用颜色区分，
 * 每条均可关闭。
 *
 * @module renderer/components/NotificationsRail
 */
import {
  TOKEN_QUOTA_WINDOW_LABEL,
  formatTokenPercent,
  formatTokenUsage,
  type Agent,
  type AgentRuntimeState,
  type AgentType,
  type NotificationRequest,
} from '@codepulse/shared'
import { formatRelative } from '../lib/format.js'

/**
 * {@link NotificationsRail} 的 props。
 */
interface Props {
  /** 各 agent 最新的运行时状态。 */
  agents: AgentRuntimeState[]
  /** 本地 CLI/hook 检测结果。 */
  detectedAgents: Agent[]
  /** 最近的通知，新者在前。 */
  notifications: NotificationRequest[]
  /** 当前时间（epoch 毫秒），用于相对时间戳。 */
  now: number
  /** 按去重键关闭一条通知。 */
  onDismiss: (dedupeKey: string, createdAt: number) => void
}

/** 每个通知级别对应的左边框颜色。 */
const LEVEL_STYLE: Record<NotificationRequest['level'], string> = {
  soft: 'border-l-gray-500',
  normal: 'border-l-green-400',
  strong: 'border-l-yellow-400',
}

const AGENT_ORDER: readonly AgentType[] = ['claude_code', 'codex']

/**
 * 渲染通知栏（`lg` 断点以下隐藏）。
 *
 * @param props 见 {@link Props}。
 * @returns 通知栏元素。
 */
export function NotificationsRail({
  agents,
  detectedAgents,
  notifications,
  now,
  onDismiss,
}: Props): JSX.Element {
  return (
    <aside className="liquid-glass hidden w-[22rem] shrink-0 overflow-y-auto rounded-2xl p-4 lg:block xl:w-96">
      <section className="mb-5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-100">本机侦测</h3>
          <span className="text-[10px] text-gray-500">CLI / Hook</span>
        </div>
        <ul className="space-y-2">
          {AGENT_ORDER.map((agentType) => (
            <DetectItem
              key={agentType}
              agentType={agentType}
              agent={detectedAgents.find((agent) => agent.type === agentType)}
            />
          ))}
        </ul>
      </section>

      <section className="mb-5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-100">Token 消耗</h3>
          <span className="rounded-full border border-cyan-200/10 bg-cyan-300/10 px-2 py-0.5 text-[10px] text-cyan-100/70">
            {TOKEN_QUOTA_WINDOW_LABEL}
          </span>
        </div>
        <ul className="space-y-2">
          {AGENT_ORDER.map((agentType) => (
            <UsageItem
              key={agentType}
              agentType={agentType}
              agent={agents.find((agent) => agent.agentType === agentType)}
            />
          ))}
        </ul>
        <p className="mt-2 text-[10px] leading-4 text-gray-500">
          百分比为 context 使用率；{TOKEN_QUOTA_WINDOW_LABEL}窗口以对应 CLI 的官方重置时间为准。
        </p>
      </section>

      <h3 className="mb-3 text-sm font-semibold text-gray-100">任务提醒</h3>
      {notifications.length === 0 ? (
        <div className="glass-subtle rounded-xl px-3 py-4 text-sm text-gray-500">暂无提醒</div>
      ) : (
        <ul className="space-y-2">
          {notifications.map((note) => (
            <li
              key={`${note.dedupeKey}-${note.createdAt}`}
              className={`glass-subtle rounded-xl border-l-2 p-3 ${LEVEL_STYLE[note.level]}`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-medium text-gray-200">{note.title}</span>
                <button
                  onClick={() => onDismiss(note.dedupeKey, note.createdAt)}
                  className="rounded-md px-1 text-xs text-gray-500 transition hover:bg-white/10 hover:text-gray-300"
                  aria-label="dismiss"
                >
                  ✕
                </button>
              </div>
              <p className="mt-1 line-clamp-3 text-xs leading-5 text-gray-400">{note.body}</p>
              <p className="mt-1 text-[10px] text-gray-600">
                {formatRelative(note.createdAt, now)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}

/** 「本机侦测」中单个 agent 的 CLI/Hook 检测行。 */
function DetectItem({
  agentType,
  agent,
}: {
  agentType: AgentType
  agent: Agent | undefined
}): JSX.Element {
  const name = agentType === 'codex' ? 'Codex' : 'Claude Code'
  const installed = agent?.installed ?? false
  const configured = agent?.configured ?? false
  return (
    <li className="glass-subtle rounded-xl p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-gray-200">{name}</span>
        <span className="truncate text-[10px] text-gray-500">
          {agent?.version ?? '未检测到版本'}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <DetectPill label="CLI" ok={installed} />
        <DetectPill label="Hook" ok={configured} />
      </div>
    </li>
  )
}

/** 「已启用/未启用」状态小胶囊。 */
function DetectPill({ label, ok }: { label: string; ok: boolean }): JSX.Element {
  return (
    <span
      className={`rounded-lg border px-2 py-1 ${
        ok
          ? 'border-emerald-200/20 bg-emerald-300/10 text-emerald-200'
          : 'border-slate-200/10 bg-white/5 text-gray-500'
      }`}
    >
      {label} {ok ? '已启用' : '未启用'}
    </span>
  )
}

/**
 * 通知栏中一行紧凑的 token 用量摘要。
 *
 * @param props.agentType 要渲染的 agent 槽位。
 * @param props.agent 最新运行时状态（agent 上报过时存在）。
 * @returns 用量摘要元素。
 */
function UsageItem({
  agentType,
  agent,
}: {
  agentType: AgentType
  agent: AgentRuntimeState | undefined
}): JSX.Element {
  const pct = agent?.token?.contextUsedPercent
  const hasPct = typeof pct === 'number'

  return (
    <li className="glass-subtle rounded-xl p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-gray-200">
          {agentType === 'codex' ? 'Codex' : 'Claude Code'}
        </span>
        <span className={`text-xs ${hasPct ? quotaTextColor(pct) : 'text-gray-500'}`}>
          {formatTokenPercent(pct)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-950/70 ring-1 ring-white/10">
        <div
          className={`neon-progress h-full rounded-full ${hasPct ? quotaBarColor(pct) : 'bg-slate-700'}`}
          style={{ width: hasPct ? `${Math.min(100, Math.max(2, pct))}%` : '0%' }}
        />
      </div>
      <p className="mt-2 truncate text-[11px] text-gray-400">{formatTokenUsage(agent?.token)}</p>
    </li>
  )
}

/** 按使用率选择配额进度条颜色：≥95% 红、≥80% 黄、其余蓝。 */
function quotaBarColor(pct: number): string {
  if (pct >= 95) return 'bg-red-500'
  if (pct >= 80) return 'bg-yellow-400'
  return 'bg-blue-400'
}

/** 按使用率选择配额百分比文字颜色。 */
function quotaTextColor(pct: number): string {
  if (pct >= 95) return 'text-red-300'
  if (pct >= 80) return 'text-yellow-300'
  return 'text-blue-300'
}
