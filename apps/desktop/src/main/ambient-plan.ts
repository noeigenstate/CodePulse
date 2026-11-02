import type { InkDisplayPlan, InkFeatureId } from '@codepulse/shared'
export function inkFeatureAt(plan: InkDisplayPlan, now: number): InkFeatureId {
  if (plan.mode === 'single') return 'work'
  return plan.items[Math.floor(now / (plan.intervalMinutes * 60000)) % plan.items.length] ?? 'work'
}
export function inkAllowsAmbient(plan: InkDisplayPlan, now: number): boolean {
  return inkFeatureAt(plan, now) === 'ambient'
}
