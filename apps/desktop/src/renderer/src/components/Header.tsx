/**
 * Dashboard 头部：产品标题、聚合总体状态指示，
 * 以及「清除提醒」/ 静音控件。
 *
 * @module renderer/components/Header
 */
import {
  TOKEN_QUOTA_WINDOW_LABEL,
  formatTokenPercent,
  type OverallState,
  type TokenPayload,
} from '@codepulse/shared'
import { overallStyle } from '../lib/format.js'
import codePulseIcon from '../assets/codepulse-icon.png'

/**
 * {@link Header} 的 props。
 */
interface Props {
  /** 要指示的聚合总体状态。 */
  overall: OverallState
  /** 最近一次同步到的 CLI 共享额度。 */
  quotaToken?: TokenPayload
  /** 通知声音当前是否静音。 */
  muted: boolean
  /** 切换静音。 */
  onToggleMute: () => void
  /** 确认所有未读提醒。 */
  onClearAlerts: () => void
}

/**
 * 渲染顶部头部栏。
 *
 * @param props 见 {@link Props}。
 * @returns 头部元素。
 */
export function Header({
  overall,
  quotaToken,
  muted,
  onToggleMute,
  onClearAlerts,
}: Props): JSX.Element {
  const style = overallStyle(overall)
  const quota = quotaToken?.rateLimits?.fiveHour
  return (
    <header className="px-6 py-5">
      <div className="flex items-center justify-between gap-5">
        <div className="flex items-center gap-3">
          <img
            src={codePulseIcon}
            alt=""
            className="h-16 w-16 shrink-0 rounded-[1.35rem] object-cover"
          />
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tracking-tight text-slate-950">
                CodePulse
              </span>
              <span className="text-xs text-amber-700">码脉</span>
            </div>
            <p className="mt-1 text-sm text-slate-500">AI coding-agent live console</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="control-glass flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${style.dot}`} />
            <span className={style.text}>{style.label}</span>
          </div>
          <div className="control-glass min-w-44 rounded-xl px-4 py-2.5">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-slate-500">{TOKEN_QUOTA_WINDOW_LABEL}</span>
              <span className="font-semibold text-amber-700">
                {formatTokenPercent(quota?.usedPercent)}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-200/80">
              <div
                className="h-full rounded-full bg-amber-500"
                style={{
                  width:
                    typeof quota?.usedPercent === 'number'
                      ? `${Math.min(100, Math.max(2, quota.usedPercent))}%`
                      : '0%',
                }}
              />
            </div>
          </div>
          <button
            onClick={onClearAlerts}
            className="control-glass rounded-xl px-4 py-3 text-sm font-medium text-slate-800 transition hover:bg-white/75 active:translate-y-px"
          >
            清除提醒
          </button>
          <button
            onClick={onToggleMute}
            className={`rounded-xl px-4 py-3 text-sm font-medium transition active:translate-y-px ${
              muted
                ? 'border border-amber-300/60 bg-amber-100/80 text-amber-800 hover:bg-amber-100'
                : 'control-glass text-slate-800 hover:bg-white/75'
            }`}
          >
            {muted ? '已静音' : '静音 30 分钟'}
          </button>
        </div>
      </div>
    </header>
  )
}
