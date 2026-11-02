import type { DeviceDisplayConfig, HudToolKey } from '@codepulse/shared'
import type { CliToolType } from './dashboardSettings.js'

/**
 * Settings › 显示的 CLI is the master switch for every surface. These helpers only ever remove a
 * tool that is switched off; they never turn a tool on in a surface.
 */

/** New HUD tool map with master-off tools cleared, or null when nothing needs to change. */
export function hudToolsAfterMasterOff(
  hudTools: Record<HudToolKey, boolean>,
  visible: Record<CliToolType, boolean>,
): Record<HudToolKey, boolean> | null {
  let changed = false
  const next = { ...hudTools }
  for (const tool of Object.keys(hudTools) as HudToolKey[]) {
    if (hudTools[tool] && visible[tool] === false) {
      next[tool] = false
      changed = true
    }
  }
  return changed ? next : null
}

/** New device display config without master-off agents, or null when nothing needs to change. */
export function displayAfterMasterOff(
  config: DeviceDisplayConfig,
  visible: Record<CliToolType, boolean>,
): DeviceDisplayConfig | null {
  const agents = config.agents.filter((agent) => visible[agent] !== false)
  return agents.length === config.agents.length ? null : { ...config, agents }
}
