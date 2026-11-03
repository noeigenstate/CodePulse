import {
  DISPLAY_AGENT_TYPES,
  normalizeDeviceDisplay,
  normalizeInkPlan,
  type DeviceDisplayConfig,
  type DeviceDisplaySnapshot,
  type InkApplyRequest,
} from '@codepulse/shared'
import type { ProductShell } from './product-shell.js'
import type { AmbientService } from './ambient-service.js'
import type { AssistantService } from './assistant-service.js'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('墨水屏配置格式无效')
  return value as Record<string, unknown>
}
/** Validate the complete request before normalizing or touching any store. */
function validateRequest(request: unknown): InkApplyRequest {
  const raw = record(request),
    plan = record(raw.plan),
    display = record(raw.display)
  const feature = (value: unknown) => value === 'work' || value === 'ambient' || value === 'todos'
  if (
    !['single', 'cycle'].includes(plan.mode as string) ||
    !feature(plan.fixed) ||
    !Array.isArray(plan.items) ||
    !plan.items.every(feature) ||
    ![5, 10, 15, 30].includes(plan.intervalMinutes as number)
  ) {
    throw new Error('节目单格式无效')
  }
  if (
    display.version !== 1 ||
    !['hud', 'usage'].includes(display.mode as string) ||
    !['remaining', 'used'].includes(display.metric as string) ||
    typeof display.showQuota !== 'boolean' ||
    typeof display.showEnvironment !== 'boolean' ||
    (display.inverted !== undefined && typeof display.inverted !== 'boolean') ||
    !Array.isArray(display.agents) ||
    !display.agents.every((agent) =>
      DISPLAY_AGENT_TYPES.includes(agent as (typeof DISPLAY_AGENT_TYPES)[number]),
    ) ||
    !Number.isInteger(display.page) ||
    (display.page as number) < 0 ||
    (display.page as number) > 9999
  ) {
    throw new Error('画面配置格式无效')
  }
  return { plan: normalizeInkPlan(plan), display: normalizeDeviceDisplay(display) }
}

export function applyInk(
  request: unknown,
  deps: {
    shell: ProductShell
    ambient: AmbientService
    readDisplay: () => DeviceDisplayConfig
    writeDisplay: (display: DeviceDisplayConfig) => unknown
    displaySnapshot: () => DeviceDisplaySnapshot
    committed: () => void
  },
) {
  const { plan, display } = validateRequest(request)
  const previousDisplay = deps.readDisplay()
  const shell = deps.shell.prepareInkPlan(plan)
  const ambientConfig = deps.ambient.getConfig()
  const enabled = plan.mode === 'cycle' && plan.items.includes('ambient')
  const ambient =
    ambientConfig.enabled === enabled && ambientConfig.displayMinutes === plan.intervalMinutes
      ? undefined
      : deps.ambient.prepareConfiguration({
          ...ambientConfig,
          enabled,
          displayMinutes: plan.intervalMinutes,
        })
  const stages = [
    shell,
    {
      save: () => deps.writeDisplay(display),
      rollback: () => deps.writeDisplay(previousDisplay),
    },
    ...(ambient ? [ambient] : []),
  ]
  const completed: typeof stages = []
  try {
    for (const stage of stages) {
      stage.save()
      completed.push(stage)
    }
  } catch (error) {
    const errors = [error]
    for (const stage of completed.reverse()) {
      try {
        stage.rollback()
      } catch (rollbackError) {
        errors.push(rollbackError)
      }
    }
    if (errors.length > 1) throw new AggregateError(errors, '墨水屏配置回滚失败，请检查本地存储')
    throw error
  }
  // All synchronous durable writes succeeded. Memory and notifications follow together.
  shell.commit()
  ambient?.commit()
  deps.committed()
  return { shell: deps.shell.snapshot(), display: deps.displaySnapshot() }
}

export function endInkTemporary(
  ambient: Pick<AmbientService, 'dismissTemporary'>,
  assistant?: Pick<AssistantService, 'clearTemporaryInk'>,
): void {
  ambient.dismissTemporary()
  assistant?.clearTemporaryInk()
}
