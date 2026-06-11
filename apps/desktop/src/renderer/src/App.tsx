/**
 * Dashboard 根组件。布局包含头部、agent 卡片网格与通知栏，
 * 并驱动 1 秒一跳的时钟，使耗时与相对时间保持实时。
 *
 * @module renderer/App
 */
import { useEffect, useState } from 'react'
import {
  TOKEN_QUOTA_WINDOW_LABEL,
  formatTokenPercent,
  formatTokenUsage,
  type TokenPayload,
} from '@codepulse/shared'
import { useStore } from './store.js'
import { Header } from './components/Header.js'
import { AgentCard } from './components/AgentCard.js'
import { NotificationsRail } from './components/NotificationsRail.js'
import { buildWorkspaceAgentGroups } from './lib/displayAgents.js'

/**
 * 应用外壳 Dashboard。
 *
 * @returns 渲染后的 Dashboard。
 */
export function App(): JSX.Element {
  const {
    snapshot,
    muted,
    agents,
    notifications,
    init,
    ack,
    clearAlerts,
    toggleMute,
    dismissNotification,
  } = useStore()
  const [now, setNow] = useState(() => Date.now())
  const workspaceGroups = buildWorkspaceAgentGroups(snapshot.agents)

  useEffect(() => init(), [init])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="app-shell flex h-full flex-col text-gray-200">
      <Header
        overall={snapshot.overall}
        muted={muted}
        onToggleMute={toggleMute}
        onClearAlerts={clearAlerts}
      />
      <div className="flex flex-1 gap-5 overflow-hidden p-5 pt-0">
        <main className="min-w-0 flex-1 overflow-y-auto pt-5">
          <div className="space-y-5">
            {workspaceGroups.map((group) => (
              <section key={group.id} className="space-y-3">
                <div className="liquid-glass rounded-2xl p-4">
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                    <div className="min-w-0">
                      <p className="hud-label">Workspace</p>
                      <h2 className="truncate text-xl font-semibold text-gray-50">{group.name}</h2>
                      <p className="mt-1 truncate text-xs text-gray-500">
                        {group.workspacePath ?? '等待 hook 上报项目路径'}
                      </p>
                    </div>
                    <WorkspaceTokenBar token={group.token} />
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-5 2xl:grid-cols-2">
                  {group.agents.map((agent) => (
                    <AgentCard
                      key={`${group.id}-${agent.agentType}`}
                      agent={agent}
                      now={now}
                      onAck={() => ack(agent.agentType, group.workspacePath)}
                      showToken={false}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </main>
        <NotificationsRail
          agents={snapshot.agents}
          detectedAgents={agents}
          notifications={notifications}
          now={now}
          onDismiss={dismissNotification}
        />
      </div>
    </div>
  )
}

function WorkspaceTokenBar({ token }: { token: TokenPayload | undefined }): JSX.Element {
  const contextPct = token?.contextUsedPercent
  const quotaPct = token?.rateLimits?.fiveHour?.usedPercent

  return (
    <div className="grid min-w-0 gap-3 xl:w-[32rem] xl:grid-cols-2">
      <TokenMeter label="Context" percent={contextPct} detail={formatTokenUsage(token)} />
      <TokenMeter
        label={TOKEN_QUOTA_WINDOW_LABEL}
        percent={quotaPct}
        detail={formatReset(token?.rateLimits?.fiveHour?.resetsAt)}
      />
    </div>
  )
}

function TokenMeter({
  label,
  percent,
  detail,
}: {
  label: string
  percent: number | undefined
  detail: string
}): JSX.Element {
  const hasPercent = typeof percent === 'number'
  const width = hasPercent ? `${Math.min(100, Math.max(2, percent))}%` : '0%'

  return (
    <div className="glass-subtle rounded-xl px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
        <span className="text-gray-400">{label}</span>
        <span className={hasPercent ? tokenTextColor(percent) : 'text-gray-500'}>
          {formatTokenPercent(percent)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-950/70 ring-1 ring-white/10">
        <div
          className={`neon-progress h-full rounded-full ${
            hasPercent ? tokenBarColor(percent) : 'bg-slate-700'
          }`}
          style={{ width }}
        />
      </div>
      <p className="mt-2 truncate text-[11px] text-gray-500">{detail}</p>
    </div>
  )
}

function formatReset(resetsAt: number | undefined): string {
  if (!resetsAt) return '以 CLI /status 为准'
  return `重置 ${new Date(resetsAt * 1000).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })}`
}

function tokenBarColor(pct: number): string {
  if (pct >= 95) return 'bg-red-500'
  if (pct >= 80) return 'bg-yellow-400'
  return 'bg-blue-400'
}

function tokenTextColor(pct: number): string {
  if (pct >= 95) return 'text-red-300'
  if (pct >= 80) return 'text-yellow-300'
  return 'text-blue-300'
}
