import { inkRotationItems, type InkDisplayPlan, type InkFeatureId } from '@codepulse/shared'
export function inkFeatureAt(plan: InkDisplayPlan, now: number): InkFeatureId {
  if (plan.mode === 'single') return plan.fixed === 'performance' ? 'performance' : 'work'
  const items = inkRotationItems(plan)
  return items[Math.floor(now / (plan.intervalMinutes * 60000)) % items.length] ?? 'work'
}
export function inkAllowsAmbient(plan: InkDisplayPlan, now: number): boolean {
  return inkFeatureAt(plan, now) === 'ambient'
}
