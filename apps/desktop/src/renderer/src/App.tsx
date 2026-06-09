/**
 * The Dashboard root component. Lays out the header, the grid of agent cards,
 * and the notifications rail, and drives a 1-second clock so durations and
 * relative times stay live.
 *
 * @module renderer/App
 */
import { useEffect, useState } from 'react'
import { useStore } from './store.js'
import { Header } from './components/Header.js'
import { AgentCard } from './components/AgentCard.js'
import { NotificationsRail } from './components/NotificationsRail.js'

/**
 * The application shell and Dashboard.
 *
 * @returns The rendered Dashboard.
 */
export function App(): JSX.Element {
  const { ready, snapshot, muted, notifications, init, ack, clearAlerts, toggleMute, dismissNotification } =
    useStore()
  const [now, setNow] = useState(() => Date.now())

  // Subscribe to status/notification pushes for the component's lifetime.
  useEffect(() => init(), [init])

  // Tick once a second so elapsed/relative times re-render.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="flex h-full flex-col bg-ink-900 text-gray-200">
      <Header
        overall={snapshot.overall}
        muted={muted}
        onToggleMute={toggleMute}
        onClearAlerts={clearAlerts}
      />
      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 overflow-y-auto p-6">
          {snapshot.agents.length === 0 ? (
            <EmptyState ready={ready} />
          ) : (
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
              {snapshot.agents.map((agent) => (
                <AgentCard
                  key={agent.agentType}
                  agent={agent}
                  now={now}
                  onAck={() => ack(agent.agentType)}
                />
              ))}
            </div>
          )}
        </main>
        <NotificationsRail notifications={notifications} now={now} onDismiss={dismissNotification} />
      </div>
    </div>
  )
}

/**
 * Placeholder shown before any agent has reported activity.
 *
 * @param props.ready Whether the initial status request has completed.
 * @returns The empty-state panel.
 */
function EmptyState({ ready }: { ready: boolean }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center text-gray-500">
      <div className="mb-3 h-3 w-3 animate-pulse rounded-full bg-blue-400" />
      <p className="text-sm">{ready ? '正在等待 Codex / Claude Code 事件…' : '正在连接本地服务…'}</p>
      <p className="mt-2 max-w-sm text-xs text-gray-600">
        在 Codex / Claude Code 中配置 CodePulse hook 后，运行一轮任务即可在此看到实时状态。
      </p>
    </div>
  )
}
