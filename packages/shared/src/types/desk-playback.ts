import { normalizePerformanceOptions, type InkPerformanceOptions } from './performance.js'
import type { InkDisplayPlan, InkFeatureId } from './product-shell.js'

const isDeskItem = (item: InkFeatureId) => item === 'ambient' || item === 'performance'

/** The two desk-content slots keep their saved order even when the entire group is paused. */
export function inkRotationItems(plan: InkDisplayPlan): InkFeatureId[] {
  return plan.deskContentPaused ? plan.items.filter((item) => !isDeskItem(item)) : plan.items
}
export function deskContentIncluded(plan: InkDisplayPlan): boolean {
  return !plan.deskContentPaused && plan.items.some(isDeskItem)
}
export function setDeskContentIncluded(plan: InkDisplayPlan, enabled: boolean): InkDisplayPlan {
  if (deskContentIncluded(plan) === enabled) return plan
  if (!enabled) return { ...plan, deskContentPaused: true }
  const { deskContentPaused: _paused, ...resumed } = plan
  return plan.items.some(isDeskItem) ? resumed : { ...resumed, items: [...plan.items, 'ambient'] }
}

export type DeskPerformancePlayback = 'preview' | 'cycle' | 'fixed'
export interface DeskPerformanceEdit {
  options?: Partial<InkPerformanceOptions>
  playback?: DeskPerformancePlayback
}
export function deskPerformancePlayback(plan: InkDisplayPlan): DeskPerformancePlayback {
  if (plan.mode === 'single' && plan.fixed === 'performance') return 'fixed'
  // A paused group still remembers the choice; the editor can remove or resume that slot.
  return plan.items.includes('performance') ? 'cycle' : 'preview'
}

/** Patch the latest saved plan. A layout-only edit never changes what is playing. */
export function updateDeskPerformance(
  plan: InkDisplayPlan,
  edit: DeskPerformanceEdit,
): InkDisplayPlan {
  if (
    !edit ||
    typeof edit !== 'object' ||
    (edit.playback !== undefined && !['preview', 'cycle', 'fixed'].includes(edit.playback))
  )
    throw new Error('Invalid performance settings')
  const next = edit.options
    ? {
        ...plan,
        performance: normalizePerformanceOptions({
          ...normalizePerformanceOptions(plan.performance),
          ...edit.options,
        }),
      }
    : plan
  if (edit.playback === undefined) return next
  if (edit.playback === 'fixed') return { ...next, mode: 'single', fixed: 'performance' }
  if (edit.playback === 'cycle') {
    const { deskContentPaused: _paused, ...resumed } = next
    return {
      ...resumed,
      mode: 'cycle',
      fixed: 'work',
      items: next.items.includes('performance') ? next.items : [...next.items, 'performance'],
    }
  }
  const items = next.items.filter((item) => item !== 'performance')
  return {
    ...next,
    items,
    ...(next.fixed === 'performance' ? { mode: 'cycle' as const, fixed: 'work' as const } : {}),
  }
}

/** Apply only the fields Control actually edited; keep simultaneous edits from the desk-content page. */
export function mergeInkControlPlan(
  base: InkDisplayPlan,
  draft: InkDisplayPlan,
  latest: InkDisplayPlan,
): InkDisplayPlan {
  let result = latest
  if (base.mode !== draft.mode || base.fixed !== draft.fixed)
    result = { ...result, mode: draft.mode, fixed: draft.fixed }
  if (base.intervalMinutes !== draft.intervalMinutes)
    result = { ...result, intervalMinutes: draft.intervalMinutes }
  if (deskContentIncluded(base) !== deskContentIncluded(draft))
    result = setDeskContentIncluded(result, deskContentIncluded(draft))
  const wantsTodos = draft.items.includes('todos')
  if (base.items.includes('todos') !== wantsTodos && result.items.includes('todos') !== wantsTodos)
    result = {
      ...result,
      items: wantsTodos
        ? [...result.items, 'todos']
        : result.items.filter((item) => item !== 'todos'),
    }
  return result
}
