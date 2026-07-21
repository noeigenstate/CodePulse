import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  normalizeWindowTheme,
  scheduledWindowTheme,
  windowChromePalette,
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

test('native title-bar colors match the renderer canvas theme tokens', () => {
  const css = readFileSync('apps/desktop/src/renderer/src/index.css', 'utf8')
  const light = windowChromePalette('light')
  const dark = windowChromePalette('dark')

  assert.match(css, new RegExp(`--canvas: ${light.backgroundColor}`))
  assert.match(css, new RegExp(`--canvas: ${dark.backgroundColor}`))
  assert.notEqual(light.symbolColor, dark.symbolColor)
})

test('renderer delegates outer corner geometry to the native window frame', () => {
  const css = readFileSync('apps/desktop/src/renderer/src/index.css', 'utf8')
  const rootShellRule = css.match(/#root > \.app-shell \{([\s\S]*?)\n  \}/)?.[1]

  assert.ok(rootShellRule)
  assert.match(rootShellRule, /border: 1px solid var\(--line\)/)
  assert.doesNotMatch(rootShellRule, /border-radius/)
  assert.doesNotMatch(rootShellRule, /contain:\s*paint/)
  assert.doesNotMatch(css, /--radius-window:/)
})
