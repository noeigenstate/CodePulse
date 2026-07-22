import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  normalizeWindowTheme,
  scheduledWindowTheme,
} from '../apps/desktop/src/main/window-chrome.js'

test('window chrome theme input uses a defensive light fallback', () => {
  assert.equal(normalizeWindowTheme('dark'), 'dark')
  assert.equal(normalizeWindowTheme('light'), 'light')
  assert.equal(normalizeWindowTheme('unexpected'), 'light')
})

test('initial window chrome follows the automatic 08:00 to 20:00 schedule', () => {
  assert.equal(scheduledWindowTheme(new Date(2026, 0, 1, 7, 59)), 'dark')
  assert.equal(scheduledWindowTheme(new Date(2026, 0, 1, 8, 0)), 'light')
  assert.equal(scheduledWindowTheme(new Date(2026, 0, 1, 19, 59)), 'light')
  assert.equal(scheduledWindowTheme(new Date(2026, 0, 1, 20, 0)), 'dark')
})

test('renderer HUD changes panel alpha without fading child text', () => {
  const css = readFileSync('apps/desktop/src/renderer/src/index.css', 'utf8')

  assert.match(css, /--hud-background-rgb: 250, 250, 248/)
  assert.match(css, /--hud-background-rgb: 25, 26, 28/)
  assert.match(css, /background: rgba\(var\(--hud-background-rgb\), var\(--hud-opacity\)\)/)
  assert.doesNotMatch(css, /\.app-shell[\s\S]*?opacity: var\(--hud-opacity\)/)
})

test('renderer owns rounded HUD geometry inside the transparent native window', () => {
  const css = readFileSync('apps/desktop/src/renderer/src/index.css', 'utf8')
  const rootShellRule = css.match(/#root > \.app-shell \{([\s\S]*?)\n  \}/)?.[1]

  assert.ok(rootShellRule)
  assert.match(rootShellRule, /border: 1px solid var\(--line\)/)
  assert.match(css, /\.app-shell \{[\s\S]*?border-radius: 18px/)
  assert.match(css, /body \{[\s\S]*?background: transparent/)
  assert.doesNotMatch(css, /\.window-titlebar/)
  assert.doesNotMatch(rootShellRule, /contain:\s*paint/)
  assert.doesNotMatch(css, /--radius-window:/)
})

test('default HUD renders a project-first single lane with an optional compact grid', () => {
  const appSource = readFileSync('apps/desktop/src/renderer/src/components/ProjectDeck.tsx', 'utf8')
  const css = readFileSync('apps/desktop/src/renderer/src/index.css', 'utf8')
  const settings = readFileSync('apps/desktop/src/renderer/src/lib/dashboardSettings.ts', 'utf8')

  assert.match(appSource, /buildProjectDeckItems/)
  assert.match(appSource, /showUsageStrip/)
  assert.match(appSource, /setHudContentHeight/)
  assert.match(settings, /projectLayout: 'list'/)
  assert.match(css, /project-deck-grid[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(css, /project-deck-grid\[data-layout='list'\]/)
  assert.doesNotMatch(appSource, /AgentPanelView/)
})
