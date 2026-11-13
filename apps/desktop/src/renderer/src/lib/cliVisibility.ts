import type {
  AgentRuntimeState,
  AgentType,
  DeviceDisplayConfig,
  HudToolKey,
} from '@codepulse/shared'
import type { CliToolType } from './dashboardSettings.js'
import { isLiveState } from './format.js'

/**
 * Settings › 显示的 CLI is the master switch for every surface. These helpers only ever remove a
 * tool that is switched off; they never turn a tool on in a surface.
 */

/** The workbench's master visibility filter, shared by its panels and running-task count. */
export function isCliVisible(agentType: AgentType, visible: Record<CliToolType, boolean>): boolean {
  return visible[agentType as CliToolType] === true
}

/** Count only running tasks whose CLI and task row are visible on the workbench. */
export function countVisibleRunningTasks(
  agents: AgentRuntimeState[],
  visible: Record<CliToolType, boolean>,
): number {
  return agents.filter(
    (agent) =>
      !agent.taskHidden && isCliVisible(agent.agentType, visible) && isLiveState(agent.state),
  ).length
}

/**
 * Patch for the HUD tool map: only the tools that are on in the HUD and off in Settings, each
 * `false`. Never a full map, so a stale copy cannot switch anything back on (main merges per key).
 * Null when nothing needs to change.
 */
export function hudToolsAfterMasterOff(
  hudTools: Record<HudToolKey, boolean>,
  visible: Record<CliToolType, boolean>,
): Partial<Record<HudToolKey, false>> | null {
  const patch: Partial<Record<HudToolKey, false>> = {}
  let changed = false
  for (const tool of Object.keys(hudTools) as HudToolKey[]) {
    if (hudTools[tool] && visible[tool] === false) {
      patch[tool] = false
      changed = true
    }
  }
  return changed ? patch : null
}

/** New device display config without master-off agents, or null when nothing needs to change. */
export function displayAfterMasterOff(
  config: DeviceDisplayConfig,
  visible: Record<CliToolType, boolean>,
): DeviceDisplayConfig | null {
  const agents = config.agents.filter((agent) => visible[agent] !== false)
  return agents.length === config.agents.length ? null : { ...config, agents }
}
