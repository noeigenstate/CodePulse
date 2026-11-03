import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_DEVICE_DISPLAY, DEFAULT_HUD_SETTINGS } from '@codepulse/shared'
import {
  displayAfterMasterOff,
  hudToolsAfterMasterOff,
} from '../apps/desktop/src/renderer/src/lib/cliVisibility.js'
import { DEFAULT_DASHBOARD_SETTINGS } from '../apps/desktop/src/renderer/src/lib/dashboardSettings.js'

const visible = (off: string[]) =>
  Object.fromEntries(
    Object.entries(DEFAULT_DASHBOARD_SETTINGS.visibleTools).map(([tool, on]) => [
      tool,
      on && !off.includes(tool),
    ]),
  ) as typeof DEFAULT_DASHBOARD_SETTINGS.visibleTools

test('HUD tools switched off in Settings are cleared and nothing else changes', () => {
  const next = hudToolsAfterMasterOff(
    DEFAULT_HUD_SETTINGS.visibleTools,
    visible(['grok', 'opencode']),
  )
  assert.deepEqual(next, { grok: false }, 'the patch names only the tool that was switched off')
})

test('the HUD patch never carries a full map, so a stale HUD state cannot be re-enabled', () => {
  const patch = hudToolsAfterMasterOff(
    DEFAULT_HUD_SETTINGS.visibleTools,
    visible(['codex', 'kimi']),
  )
  assert.deepEqual(patch, { codex: false, kimi: false })
  assert.ok(Object.values(patch!).every((value) => value === false))
  assert.equal(Object.keys(patch!).length, 2)
})

test('HUD tools are untouched when every enabled tool is still visible', () => {
  assert.equal(hudToolsAfterMasterOff(DEFAULT_HUD_SETTINGS.visibleTools, visible([])), null)
})

test('a tool that is off in the HUD stays off even when Settings shows it', () => {
  const hud = { ...DEFAULT_HUD_SETTINGS.visibleTools, kimi: false }
  assert.equal(hudToolsAfterMasterOff(hud, visible([])), null)
})

test('device display agents lose master-off tools and keep the rest in order', () => {
  const config = {
    ...DEFAULT_DEVICE_DISPLAY,
    agents: ['codex', 'claude_code', 'grok'] as ('codex' | 'claude_code' | 'grok')[],
  }
  assert.deepEqual(displayAfterMasterOff(config, visible(['claude_code']))?.agents, [
    'codex',
    'grok',
  ])
  assert.equal(displayAfterMasterOff(config, visible([])), null)
  assert.deepEqual(
    displayAfterMasterOff(config, visible(['codex', 'claude_code', 'grok']))?.agents,
    [],
  )
})
