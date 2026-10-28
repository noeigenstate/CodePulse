import type { InkDisplayPlan } from '@codepulse/shared'
export function inkAllowsAmbient(plan: InkDisplayPlan, now: number): boolean {
  if (plan.mode === 'single') return plan.fixed === 'ambient'
  if (!plan.items.length) return false
  return (
    plan.items[Math.floor(now / (plan.intervalMinutes * 60000)) % plan.items.length] === 'ambient'
  )
}
