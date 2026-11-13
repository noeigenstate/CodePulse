import type { Locale } from '../lib/i18n.js'
import { RailTip } from './RailTip.js'

/** The words of the global run status; one string serves the pill, the tooltip and the live region. */
export function railStatusText(tasks: number, locale: Locale): string {
  if (locale === 'zh') return tasks > 0 ? `运行正常 · ${tasks} 个任务执行中` : '运行正常 · 空闲'
  return tasks > 0
    ? `Running · ${tasks} ${tasks === 1 ? 'task' : 'tasks'} active`
    : 'Running · idle'
}

/**
 * The sidebar's global run status: tasks executing right now, from the shared agent snapshot.
 * A live region, so a change is announced. Collapsed, only the dot shows; the words stay readable
 * to assistive technology and appear as a tooltip on hover or focus.
 */
export function RailStatus({
  tasks,
  locale,
  collapsed = false,
}: {
  tasks: number
  locale: Locale
  collapsed?: boolean
}): JSX.Element {
  const text = railStatusText(tasks, locale)
  return (
    <div className="product-rail-status-wrap">
      <div
        className={`product-rail-status ${tasks > 0 ? 'is-busy' : 'is-idle'}`}
        role="status"
        tabIndex={collapsed ? 0 : undefined}
      >
        <span className="product-rail-status-dot" aria-hidden="true" />
        <span className="product-rail-status-text">{text}</span>
      </div>
      <RailTip>{text}</RailTip>
    </div>
  )
}
