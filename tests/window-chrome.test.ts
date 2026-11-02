import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { windowChromePalette } from '../apps/desktop/src/main/window-chrome.js'

/** The native caption buttons sit beside the renderer title bar: both must use one token set. */
function workstationTokens(dark: boolean): { canvas: string; ink: string } {
  const css = readFileSync('apps/desktop/src/renderer/src/components/product-shell.css', 'utf8')
  const selector = dark ? ":root[data-theme='dark'] .app-shell.native-workstation {" : '.app-shell.native-workstation {'
  const start = css.indexOf(selector)
  assert.ok(start >= 0, `missing ${selector}`)
  const block = css.slice(start, css.indexOf('}', start))
  const token = (name: string) => block.match(new RegExp(`--${name}:\s*(#[0-9a-f]{6})`, 'i'))?.[1]?.toLowerCase()
  return { canvas: token('canvas')!, ink: token('ink')! }
}

test('native caption buttons use the workstation canvas and ink tokens in both themes', () => {
  for (const [theme, dark] of [['light', false], ['dark', true]] as const) {
    const tokens = workstationTokens(dark)
    const palette = windowChromePalette(theme)
    assert.equal(palette.backgroundColor.toLowerCase(), tokens.canvas, `${theme} background`)
    assert.equal(palette.symbolColor.toLowerCase(), tokens.ink, `${theme} symbols`)
  }
})
