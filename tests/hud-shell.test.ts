import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TurnState } from '@codepulse/shared'
import {
  HUD_TRANSPARENT_BACKGROUND,
  HUD_WINDOW_OPACITY,
  HUD_WINDOW_SHELL_OPTIONS,
  applyHudWindowTheme,
  deriveHudOverall,
  hudContentHeightForDisplay,
  hudWindowBoundsForDisplay,
  preserveHudWindowSurface,
  selectHudDisplay,
  showHudInactive,
  shouldRevealHud,
  type HudDisplay,
} from '../apps/desktop/src/main/hud-window.js'
import {
  trayAgentNameFor,
  trayIconPngFor,
  trayVisualColorFor,
  trayVisualToneFor,
} from '../apps/desktop/src/main/tray-icon-png.js'

function display(id: number, x: number, y: number, width = 1920, height = 1040): HudDisplay {
  return {
    id,
    bounds: { x, y, width, height: height + 40 },
    workArea: { x, y, width, height },
  }
}

test('HUD display selection prefers the right-most display to the right of primary', () => {
  const primary = display(1, 0, 0)
  const left = display(2, -1920, 0)
  const right = display(3, 1920, 0)
  const farRight = display(4, 3840, -200)

  assert.equal(selectHudDisplay([left, farRight, primary, right], primary.id)?.id, farRight.id)
})

test('HUD display selection falls back to a secondary and then primary', () => {
  const primary = display(1, 0, 0)
  const left = display(2, -1920, 0)
  const above = display(3, 0, -1080)

  assert.equal(selectHudDisplay([left, above, primary], primary.id)?.id, above.id)
  assert.equal(selectHudDisplay([primary], primary.id)?.id, primary.id)
  assert.equal(selectHudDisplay([], primary.id), undefined)
})

test('HUD bounds use the work-area top-right margin and clamp to small displays', () => {
  const normal = display(2, 1920, -120)
  assert.deepEqual(hudWindowBoundsForDisplay(normal), {
    x: 3176,
    y: -96,
    width: 640,
    height: 240,
  })

  const small = display(3, 100, 50, 640, 400)
  assert.deepEqual(hudWindowBoundsForDisplay(small), {
    x: 124,
    y: 74,
    width: 592,
    height: 240,
  })
})

test('HUD content height follows the project stack and clamps to the display lane', () => {
  const normal = display(2, 1920, 0)
  assert.equal(hudContentHeightForDisplay(264, normal), 264)
  assert.equal(hudContentHeightForDisplay(40, normal), 132)
  assert.equal(hudContentHeightForDisplay(2_000, normal), 992)
})

test('HUD native surface remains opacity 1 with a transparent background', () => {
  const calls: Array<[string, string | number]> = []
  preserveHudWindowSurface({
    isDestroyed: () => false,
    setBackgroundColor: (color) => calls.push(['background', color]),
    setOpacity: (opacity) => calls.push(['opacity', opacity]),
  })

  assert.deepEqual(calls, [
    ['background', HUD_TRANSPARENT_BACKGROUND],
    ['opacity', HUD_WINDOW_OPACITY],
  ])
  assert.equal(HUD_WINDOW_OPACITY, 1)
  assert.deepEqual(HUD_WINDOW_SHELL_OPTIONS, {
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    opacity: 1,
    backgroundColor: HUD_TRANSPARENT_BACKGROUND,
  })
})

test('renderer theme changes cannot make the HUD native background opaque', () => {
  const backgrounds: string[] = []
  const opacities: number[] = []
  const target = {
    isDestroyed: () => false,
    setBackgroundColor: (color: string) => backgrounds.push(color),
    setOpacity: (opacity: number) => opacities.push(opacity),
  }

  assert.equal(applyHudWindowTheme('dark', target), 'dark')
  assert.deepEqual(backgrounds, [HUD_TRANSPARENT_BACKGROUND])
  assert.deepEqual(opacities, [1])
})

test('HUD reveal uses showInactive without an activation API', () => {
  let inactiveShows = 0
  assert.equal(
    showHudInactive({
      isDestroyed: () => false,
      showInactive: () => inactiveShows++,
    }),
    true,
  )
  assert.equal(inactiveShows, 1)
})

test('only attention states passively reveal the HUD', () => {
  assert.equal(shouldRevealHud('idle'), false)
  assert.equal(shouldRevealHud('running'), false)
  for (const state of ['attention', 'done_unread', 'error', 'stuck', 'limited'] as const) {
    assert.equal(shouldRevealHud(state), true)
  }
})

test('HUD aggregation cannot let active work hide another project notification', () => {
  const runtime = (
    state: TurnState,
    unread: boolean,
    workspacePath: string,
    taskHidden = false,
  ) => ({
    agentType: 'codex' as const,
    state,
    workspacePath,
    toolCallCount: 0,
    needPermission: state === TurnState.WAITING_PERMISSION,
    needUserInput: state === TurnState.WAITING_USER_INPUT,
    lastEventAt: 1,
    unread,
    taskHidden,
  })

  const running = runtime(TurnState.TOOL_RUNNING, false, 'E:/running')
  const completed = runtime(TurnState.DONE, true, 'E:/completed')
  assert.equal(
    deriveHudOverall({ overall: 'running', agents: [running, completed], updatedAt: 1 }),
    'done_unread',
  )
  assert.equal(
    deriveHudOverall({
      overall: 'error',
      agents: [running, runtime(TurnState.ERROR, false, 'E:/acknowledged')],
      updatedAt: 1,
    }),
    'running',
  )
  assert.equal(
    deriveHudOverall({
      overall: 'idle',
      agents: [runtime(TurnState.DONE, true, 'E:/hidden', true)],
      updatedAt: 1,
    }),
    'idle',
  )
})

test('tray uses neutral routine color and one orange attention language', () => {
  assert.equal(trayVisualToneFor('idle'), 'neutral')
  assert.equal(trayVisualToneFor('running'), 'neutral')
  assert.deepEqual(trayVisualColorFor('idle'), [148, 163, 184])
  assert.deepEqual(trayVisualColorFor('running'), [148, 163, 184])
  for (const state of ['attention', 'done_unread', 'error', 'stuck', 'limited'] as const) {
    assert.equal(trayVisualToneFor(state), 'attention')
    assert.deepEqual(trayVisualColorFor(state), [249, 115, 22])
    assert.deepEqual(trayIconPngFor(state), trayIconPngFor('attention'))
  }
  assert.notDeepEqual(trayIconPngFor('running'), trayIconPngFor('attention'))
})

test('tray labels every supported CLI without folding Kimi into Claude', () => {
  assert.equal(trayAgentNameFor('claude_code'), 'Claude Code')
  assert.equal(trayAgentNameFor('codex'), 'Codex')
  assert.equal(trayAgentNameFor('grok'), 'Grok')
  assert.equal(trayAgentNameFor('kimi'), 'Kimi Code')
})
