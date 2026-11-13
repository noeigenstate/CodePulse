import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { windowChromePalette } from '../apps/desktop/src/main/window-chrome.js'

const SHELL_CSS = 'apps/desktop/src/renderer/src/components/product-shell.css'

/** The native caption buttons sit over the main area: they must use the renderer's own tokens. */
function workstationTokens(dark: boolean): { canvas: string; mutedSurface: string; ink: string } {
  const css = readFileSync(SHELL_CSS, 'utf8')
  const selector = dark
    ? ":root[data-theme='dark'] .app-shell.native-workstation {"
    : '.app-shell.native-workstation {'
  const start = css.indexOf(selector)
  assert.ok(start >= 0, `missing ${selector}`)
  const block = css.slice(start, css.indexOf('}', start))
  const token = (name: string) =>
    block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1]?.toLowerCase()
  return {
    canvas: token('canvas')!,
    mutedSurface: token('surface-muted')!,
    ink: token('ink')!,
  }
}

test('native window colors follow the workstation tokens in both themes', () => {
  for (const [theme, dark] of [
    ['light', false],
    ['dark', true],
  ] as const) {
    const tokens = workstationTokens(dark)
    const palette = windowChromePalette(theme)
    assert.equal(palette.backgroundColor.toLowerCase(), tokens.canvas, `${theme} background`)
    assert.equal(
      palette.overlayColor.toLowerCase(),
      tokens.mutedSurface,
      `${theme} caption buttons`,
    )
    assert.equal(palette.symbolColor.toLowerCase(), tokens.ink, `${theme} symbols`)
  }
})

test('the main area, which the caption buttons sit over, uses the same muted surface', () => {
  const css = readFileSync(SHELL_CSS, 'utf8')
  assert.match(css, /\.product-main\s*\{\s*background:\s*var\(--surface-muted\);\s*\}/)
  assert.match(css, /\.product-dragbar\s*\{[^}]*height:\s*env\(titlebar-area-height, 32px\)/)
  assert.match(css, /\.product-dragbar\s*\{[^}]*background:\s*var\(--surface-muted\)/)
  assert.doesNotMatch(css, /\.window-titlebar/)
})
