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
