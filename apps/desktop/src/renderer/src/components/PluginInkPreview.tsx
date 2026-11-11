import type { DeviceStatusV1 } from '@codepulse/shared'
import { DeviceScreenPreview } from './DeviceScreenPreview.js'
import { InfoTip } from './InfoTip.js'

export function PluginInkPreview({
  status,
  loading,
  error,
  empty = '还没有生成卡片',
  reason,
  disabled,
  onShow,
  onRetry,
  message,
  cornerTag = '预览',
  sample = true,
  live = false,
}: {
  status?: DeviceStatusV1
  loading?: boolean
  error?: boolean
  empty?: string
  reason?: string
  disabled: boolean
  onShow: () => void
  onRetry?: () => void
  message?: string
  cornerTag?: string
  sample?: boolean
  live?: boolean
}): JSX.Element {
  return (
    <section className="plugin-details-section plugin-ink-preview">
      <h3>墨水屏效果</h3>
      {status ? (
        <DeviceScreenPreview
          status={status}
          fit
          compact
          sample={sample}
          live={live}
          cornerTag={cornerTag}
        />
      ) : error ? (
        <p className="ambient-empty" role="alert">
          预览暂不可用{' '}
          {onRetry && (
            <button type="button" className="product-button is-compact" onClick={onRetry}>
              重试
            </button>
          )}
        </p>
      ) : (
        <p className="ambient-empty" role="status">
          {loading ? '正在读取画面…' : empty}
        </p>
      )}
      <div className="plugin-preview-actions">
        <button
          type="button"
          className="product-button primary"
          disabled={disabled}
          onClick={onShow}
        >
          临时展示 10 分钟
        </button>
        {reason && <InfoTip text={reason} label="为什么不能临时展示" />}
      </div>
      {message && (
        <p className="ambient-message" role="status">
          {message}
        </p>
      )}
    </section>
  )
}
