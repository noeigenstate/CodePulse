import type { DeviceDisplayConfig, InkCycleInterval, InkDisplayPlan } from '@codepulse/shared'

export type InkPlanChoice = 'fixed' | '5' | '10' | '15' | '30'

export function inkPlanChoice(plan: InkDisplayPlan): InkPlanChoice {
  return plan.mode === 'single' ? 'fixed' : (String(plan.intervalMinutes) as InkPlanChoice)
}

/** The select changes playback only; fixed work retains the user's next cycle configuration. */
export function selectInkPlan(plan: InkDisplayPlan, choice: string): InkDisplayPlan {
  if (choice === 'fixed') return { ...plan, mode: 'single', fixed: 'work' }
  if (!['5', '10', '15', '30'].includes(choice)) return plan
  return {
    ...plan,
    mode: 'cycle',
    fixed: 'work',
    intervalMinutes: Number(choice) as InkCycleInterval,
  }
}

export function inkControlChanges(
  plan: InkDisplayPlan,
  display: DeviceDisplayConfig,
  savedPlan: InkDisplayPlan,
  savedDisplay?: DeviceDisplayConfig,
): string[] {
  return [
    ...(['ambient', 'todos'] as const).filter(
      (item) => plan.items.includes(item) !== savedPlan.items.includes(item),
    ),
    ...(plan.mode !== savedPlan.mode ||
    (plan.mode === 'cycle' && plan.intervalMinutes !== savedPlan.intervalMinutes)
      ? ['playback']
      : []),
    ...(savedDisplay && JSON.stringify(display) !== JSON.stringify(savedDisplay)
      ? ['display']
      : []),
  ]
}

export interface InkBaseline {
  plan: InkDisplayPlan
  display: DeviceDisplayConfig
}

/**
 * The offline baseline: what the device last had. While a device is connected it follows the saved
 * state; once it is gone the baseline stays put (or, if the page opened offline, is taken from the
 * first saved state), so offline changes that auto-apply are still counted until the device
 * connects or the changes return to the baseline.
 */
export function nextInkBaseline(
  previous: InkBaseline | undefined,
  state: { connected: boolean; saving: boolean; plan: InkDisplayPlan; display?: DeviceDisplayConfig },
): InkBaseline | undefined {
  if (!state.display) return previous
  if (state.connected) return state.saving ? previous : { plan: state.plan, display: state.display }
  return previous ?? { plan: state.plan, display: state.display }
}
