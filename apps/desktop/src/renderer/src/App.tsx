/**
 * Dashboard 根组件。布局包含头部、agent 卡片网格与通知栏，
 * 并驱动 1 秒一跳的时钟，使耗时与相对时间保持实时。
 *
 * @module renderer/App
 */
import { useEffect, useState } from 'react'
import { useStore } from './store.js'
import { Header } from './components/Header.js'
import { AgentCard } from './components/AgentCard.js'
import { NotificationsRail } from './components/NotificationsRail.js'
import { buildDisplayAgents } from './lib/displayAgents.js'

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
  const displayAgents = buildDisplayAgents(snapshot.agents)

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
          <div className="grid grid-cols-1 gap-5 2xl:grid-cols-2">
            {displayAgents.map((agent) => (
              <AgentCard
                key={agent.agentType}
                agent={agent}
                now={now}
                onAck={() => ack(agent.agentType)}
              />
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
