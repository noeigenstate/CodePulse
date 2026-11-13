import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const css = readFileSync('apps/desktop/src/renderer/src/components/product-shell.css', 'utf8')

function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector)
  assert.ok(start >= 0, selector)
  return Object.fromEntries(
    Array.from(
      css.slice(start, css.indexOf('}', start)).matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi),
      ([, name, color]) => [name!, color!],
    ),
  )
}

function luminance(hex: string): number {
  const channels = hex.match(/[\da-f]{2}/gi)!.map((channel) => {
    const value = parseInt(channel, 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
}

function contrast(a: string, b: string): number {
  const first = luminance(a),
    second = luminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

for (const [theme, shellSelector, statusSelector] of [
  ['light', '.app-shell.native-workstation {', '.app-shell { --ok:'],
  [
    'dark',
    ":root[data-theme='dark'] .app-shell.native-workstation {",
    ":root[data-theme='dark'] .app-shell { --ok:",
  ],
] as const) {
  const shell = tokens(shellSelector)
  const status = tokens(statusSelector)

  test(`${theme} sidebar group labels meet 4.5:1 while remaining secondary to navigation`, () => {
    const group = contrast(shell['rail-group-ink']!, shell.canvas!)
    assert.ok(group >= 4.5, `group contrast ${group}`)
    assert.ok(group < contrast(shell['ink-700']!, shell.canvas!))
    assert.equal(shell['ink-muted'], theme === 'light' ? '#777c84' : '#959ca7')
  })

  test(`${theme} inactive language and separator colors meet 4.5:1 on normal and hovered rows`, () => {
    for (const background of [shell.canvas!, shell['surface-selected']!]) {
      const secondary = contrast(shell['ink-700']!, background)
      assert.ok(secondary >= 4.5, `secondary contrast ${secondary}`)
      assert.ok(secondary < contrast(shell.ink!, background))
    }
  })

  test(`${theme} run-status fill stays visible and its text meets 4.5:1`, () => {
    const text = contrast(status['ok-text']!, status['ok-soft']!)
    const fill = contrast(status['ok-soft']!, shell.canvas!)
    assert.ok(text >= 4.5, `status text contrast ${text}`)
    // Preserve a visible pale-green shape without treating this design threshold as a WCAG rule.
    assert.ok(fill >= 1.2, `status fill contrast ${fill}`)
    assert.ok(contrast(shell['ink-700']!, shell['surface-selected']!) >= 4.5)
  })

  test(`${theme} settings-card secondary text meets 4.5:1 both normally and on hover`, () => {
    for (const background of [shell['surface-solid']!, shell['surface-selected']!]) {
      const secondary = contrast(shell['ink-700']!, background)
      assert.ok(secondary >= 4.5, `settings text contrast ${secondary}`)
    }
    assert.match(
      css,
      /\.settings-work-voice-card, \.product-state-guide \{ --settings-secondary-ink:var\(--ink-700\); \}/,
    )
    assert.match(css, /summary small \{[^}]*font-size:var\(--fs-xs\)/)
    assert.match(
      css,
      /\.work-voice-options \.product-caption, \.settings-work-voice-card > \.product-caption \{[^}]*color:var\(--settings-secondary-ink\)/,
    )
    assert.match(
      css,
      /\.work-voice-details > summary small \{[^}]*color:var\(--settings-secondary-ink\)/,
    )
  })
}
