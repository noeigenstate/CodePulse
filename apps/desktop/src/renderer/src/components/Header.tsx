/**
 * Dashboard 头部：产品标题、聚合总体状态指示，
 * 以及「清除提醒」/ 静音控件。
 *
 * @module renderer/components/Header
 */
import { type OverallState } from '@codepulse/shared'
import { overallStyle } from '../lib/format.js'
import codePulseIcon from '../assets/codepulse-icon.png'

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
    <header className="px-5 py-3.5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <img
            src={codePulseIcon}
            alt=""
            className="app-logo h-[3.25rem] w-[3.25rem] shrink-0 rounded-full object-contain"
          />
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-[1.65rem] font-semibold leading-none tracking-tight text-slate-950">
                CodePulse
              </span>
              <span className="text-xs text-amber-700">码脉</span>
            </div>
            <p className="mt-1 text-xs font-medium text-slate-500">AI coding-agent live console</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="control-glass flex h-11 items-center gap-2 rounded-xl px-3.5 text-sm font-medium">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${style.dot}`} />
            <span className={style.text}>{style.label}</span>
          </div>
          <button
            onClick={onClearAlerts}
            className="control-glass h-11 rounded-xl px-3.5 text-sm font-medium text-slate-800 transition hover:bg-white/75 active:translate-y-px"
          >
            清除提醒
          </button>
          <button
            onClick={onToggleMute}
            className={`h-11 rounded-xl px-3.5 text-sm font-medium transition active:translate-y-px ${
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
