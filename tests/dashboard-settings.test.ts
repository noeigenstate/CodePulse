import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyTheme,
  CLI_TOOL_TYPES,
  readDashboardSettings,
  writeDashboardSettings,
} from '../apps/desktop/src/renderer/src/lib/dashboardSettings.js'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

test('dashboard settings default to a white theme with every CLI panel visible', () => {
  const settings = readDashboardSettings(new MemoryStorage())

  assert.equal(settings.theme, 'light')
  assert.deepEqual(
    CLI_TOOL_TYPES.filter((tool) => settings.visibleTools[tool]),
    ['codex', 'claude_code', 'grok'],
  )
})

test('dashboard settings preserve saved theme and CLI visibility while filling new tools', () => {
  const storage = new MemoryStorage()
  storage.setItem(
    'codepulse:dashboard-settings',
    JSON.stringify({ theme: 'dark', visibleTools: { codex: false } }),
  )

  const settings = readDashboardSettings(storage)
  assert.equal(settings.theme, 'dark')
  assert.equal(settings.visibleTools.codex, false)
  assert.equal(settings.visibleTools.claude_code, true)
  assert.equal(settings.visibleTools.grok, true)
})

test('dashboard settings persist changes and apply the selected root theme', () => {
  const storage = new MemoryStorage()
  const next = {
    theme: 'dark' as const,
    visibleTools: { codex: true, claude_code: false, grok: true },
  }
  writeDashboardSettings(storage, next)

  assert.deepEqual(readDashboardSettings(storage), next)
  const root: { dataset: { theme?: string } } = { dataset: {} }
  applyTheme(root, next.theme)
  assert.equal(root.dataset.theme, 'dark')
})

test('dashboard settings retain safe in-memory defaults when storage is unavailable', () => {
  const unavailableStorage = {
    getItem: () => {
      throw new Error('storage blocked')
    },
    setItem: () => {
      throw new Error('storage full')
    },
  }

  assert.equal(readDashboardSettings(unavailableStorage).theme, 'light')
  assert.doesNotThrow(() =>
    writeDashboardSettings(unavailableStorage, {
      theme: 'dark',
      visibleTools: { codex: true, claude_code: true, grok: true },
    }),
  )
})
