/**
 * Dashboard 头部：产品标题、聚合总体状态指示，
 * 以及「清除提醒」/ 静音控件。
 *
 * @module renderer/components/Header
 */
import type { OverallState } from '@codepulse/shared'
import { overallStyle } from '../lib/format.js'

/**
 * {@link Header} 的 props。
 */
interface Props {
  /** 要指示的聚合总体状态。 */
  overall: OverallState
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
export function Header({ overall, muted, onToggleMute, onClearAlerts }: Props): JSX.Element {
  const style = overallStyle(overall)
  return (
    <header className="px-5 py-4">
      <div className="liquid-glass flex items-center justify-between rounded-2xl px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-200/20 bg-cyan-300/10 shadow-[0_0_28px_rgb(34_211_238_/_0.22)]">
            <span className="h-1.5 w-6 rounded-full bg-cyan-300 shadow-[0_0_18px_rgb(103_232_249_/_0.85)]" />
            <span className="absolute h-6 w-1.5 rounded-full bg-cyan-200/80 shadow-[0_0_18px_rgb(103_232_249_/_0.55)]" />
          </span>
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-semibold tracking-tight text-gray-50">CodePulse</span>
              <span className="text-xs text-cyan-200/70">码脉桌面端</span>
            </div>
            <p className="mt-0.5 text-[11px] text-gray-500">AI coding-agent live console</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="glass-subtle flex items-center gap-2 rounded-full px-3 py-1.5 text-sm">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${style.dot}`} />
            <span className={style.text}>{style.label}</span>
          </div>
          <button
            onClick={onClearAlerts}
            className="rounded-lg border border-cyan-100/10 bg-white/5 px-3 py-1.5 text-xs text-gray-300 transition hover:border-cyan-200/30 hover:bg-cyan-200/10 active:translate-y-px"
          >
            清除提醒
          </button>
          <button
            onClick={onToggleMute}
            className={`rounded-lg px-3 py-1.5 text-xs transition active:translate-y-px ${
              muted
                ? 'border border-yellow-300/20 bg-yellow-500/20 text-yellow-200 hover:bg-yellow-500/30'
                : 'border border-cyan-100/10 bg-white/5 text-gray-300 hover:border-cyan-200/30 hover:bg-cyan-200/10'
            }`}
          >
            {muted ? '已静音' : '静音 30 分钟'}
          </button>
        </div>
      </div>
    </header>
  )
}
