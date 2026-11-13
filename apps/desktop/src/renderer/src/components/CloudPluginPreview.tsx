import { useEffect, useState } from 'react'
import type { AmbientSnapshot, DeviceStatusV1 } from '@codepulse/shared'
import { pluginPreviewCard } from '../lib/pluginPresentation.js'
import { useInkStatus } from '../lib/useInkStatus.js'
import { PluginInkPreview } from './PluginInkPreview.js'

export function CloudPluginPreview({
  pluginId,
  snapshot,
  active,
}: {
  pluginId: string
  active: boolean
  snapshot?: AmbientSnapshot
}): JSX.Element {
  const card = pluginPreviewCard(snapshot?.cards ?? [], pluginId, snapshot?.activeId)
  const [preview, setPreview] = useState<{ id: string; status: DeviceStatusV1 }>()
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const ink = useInkStatus(active)
  const online = ink?.connection === 'connected'
  useEffect(() => {
    if (!active) return
    setPreview(undefined)
    setError(false)
    setMessage('')
    if (!card) return
    let alive = true
    void window.codepulse
      .previewAmbient(card.id)
      .then((status) => {
        if (alive) setPreview({ id: card.id, status })
      })
      .catch(() => {
        if (alive) setError(true)
      })
    return () => {
      alive = false
    }
  }, [active, card, attempt])
  const current = preview?.id === card?.id ? preview?.status : undefined
  const reason = !online ? '连接设备后可临时展示' : !card ? '还没有生成卡片' : undefined
  return (
    <PluginInkPreview
      status={current}
      loading={Boolean(card) && !current && !error}
      error={error}
      disabled={busy || !card || !online}
      reason={reason}
      message={message}
      onRetry={() => setAttempt((old) => old + 1)}
      onShow={() => {
        if (!card || busy || !online) return
        setBusy(true)
        setMessage('')
        void window.codepulse
          .showAmbient(card.id)
          .then(() => {
            setMessage('已临时展示，10 分钟后自动回到节目单。')
          })
          .catch(() => setMessage('展示未完成，卡片可能已过期，请刷新后重试。'))
          .finally(() => setBusy(false))
      }}
    />
  )
}
