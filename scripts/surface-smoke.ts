import { app, BrowserWindow, ipcMain, nativeImage, screen as screenApi } from 'electron'
import { resolve, join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  createDeviceRenderer,
  frameToRgba,
} from '../apps/desktop/src/renderer/src/device-preview/renderer.mjs'
import { StatusHub } from '@codepulse/core'
import { reduce } from '../packages/core/src/state-machine/index.js'
import {
  DEFAULT_AMBIENT,
  DEFAULT_DEVICE_DISPLAY,
  TurnState,
  normalizeDeviceDisplay,
  normalizeShellPreferences,
  targetForProductView,
  type DeviceDisplayConfig,
  type AgentRuntimeState,
  type StatusSnapshot,
} from '@codepulse/shared'
import { ProductShell, shellPreferenceStore } from '../apps/desktop/src/main/product-shell.js'
import { windowChromePalette } from '../apps/desktop/src/main/window-chrome.js'
import { INK_STATUS_HEARTBEAT_MS } from '../apps/desktop/src/renderer/src/lib/useInkStatus.js'
import { WORK_VOICE_HEARTBEAT_MS } from '../apps/desktop/src/renderer/src/components/WorkVoiceSettings.js'
import { registerProductIpc } from '../apps/desktop/src/main/product-ipc.js'
import { ScreenWorkbenchWindow } from '../apps/desktop/src/main/screen-workbench-window.js'
import { AmbientService } from '../apps/desktop/src/main/ambient-service.js'
import { createAmbientRuntime } from '../apps/desktop/src/main/ambient-runtime.js'
import { registerAmbientIpc } from '../apps/desktop/src/main/ambient-ipc.js'
import { withAmbient } from '../apps/desktop/src/main/ambient-rules.js'
import { HudSurface } from '../apps/desktop/src/main/hud-surface.js'
import { hudOrbPositionForStage, hudStageForStyle } from '../apps/desktop/src/main/hud-window.js'
import { createDeviceDisplayProjector } from '../apps/desktop/src/main/device-display-projection.js'
import { AssistantStore } from '../apps/desktop/src/main/assistant-store.js'
import { AssistantService } from '../apps/desktop/src/main/assistant-service.js'
import { LumaAssistantProvider } from '../apps/desktop/src/main/assistant-provider.js'
import { registerAssistantIpc } from '../apps/desktop/src/main/assistant-ipc.js'
import { inkFeatureAt } from '../apps/desktop/src/main/ambient-plan.js'
import { selectDeskContent } from '../apps/desktop/src/main/assistant-presentation.js'
import { computeInkStatus } from '../apps/desktop/src/main/ink-status.js'
import { applyInk, endInkTemporary } from '../apps/desktop/src/main/ink-apply.js'
import {
  YuanbaoClient,
  yuanbaoCredentials,
  yuanbaoResponseJson,
  zonedParts,
  type YuanbaoCredentials,
} from '../apps/desktop/src/main/ambient-yuanbao.js'

const output = resolve('.tmpshots/surface-smoke', process.env.CODEPULSE_SMOKE_RUN ?? 'local')
const captureAll = process.env.CODEPULSE_SMOKE_CAPTURE_ALL === '1'
const smokeStartedAt = Date.now()
mkdirSync(output, { recursive: true })
app.setPath('userData', join(output, 'profile'))
app.disableHardwareAcceleration() // Isolated software rendering gives fresh hidden-window captures.
const errors: string[] = [],
  visible = new Map<number, boolean>()
const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms))
// Full captures include extra hover/focus screenshots and need more time.
const deadline = setTimeout(
  () => {
    writeFileSync(join(output, 'failure.txt'), 'timeout')
    app.exit(1)
  },
  captureAll ? 180000 : 120000,
)
app.on('browser-window-created', (_e, win) => {
  // Exercise real window constructors and renderers without showing test windows.
  win.show = () => {
    visible.set(win.id, true)
  }
  win.showInactive = () => {
    visible.set(win.id, true)
  }
  win.hide = () => {
    visible.set(win.id, false)
  }
  win.isVisible = () => visible.get(win.id) ?? false
  win.webContents.setBackgroundThrottling(false)
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message)
  })
})
async function until(check: () => boolean | Promise<boolean>, description: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await wait(80)
  }
  throw new Error('Timeout: ' + description)
}
async function click(win: BrowserWindow, selector: string) {
  assert.ok(
    await win.webContents.executeJavaScript(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    ),
    selector,
  )
  await win.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)}).click()`,
  )
  await wait()
}
async function closePluginDetails(win: BrowserWindow) {
  await win.webContents.executeJavaScript(
    `document.querySelector('.plugin-details-layer:not([hidden]) .plugin-details-close button')?.click()`,
  )
  await wait()
}
async function openInstalledPlugins(win: BrowserWindow, id?: string) {
  await closePluginDetails(win)
  await click(win, '[data-view=plugins]')
  await click(win, '#plugins-installed-tab')
  if (id) await click(win, `.plugin-row[data-plugin-id="${id}"] .plugin-actions button`)
}
async function openCurrentSurface(win: BrowserWindow) {
  await closePluginDetails(win)
  await win.webContents.executeJavaScript(`window.codepulse.navigateProduct('control')`)
  await wait()
}
async function button(win: BrowserWindow, label: string) {
  const code = `(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.getClientRects().length && !b.disabled && b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error(${JSON.stringify('Missing button: ' + label)});b.click()})()`
  await win.webContents.executeJavaScript(code)
  await wait()
}
// A device pixel must cover a whole number (>= minK) of physical pixels, or 1px strokes blur unevenly.
// The canvas must also start on a physical pixel (layout units are 1/64 css px, so allow 0.03), or it paints 400k+-1 wide.
function assertWholePixels(
  [width, height]: number[],
  dpr: number,
  minK: number,
  message: string,
  [left, top]: number[] = [],
) {
  const k = (width! * dpr) / 400
  assert.ok(
    Math.abs(k - Math.round(k)) < 0.01 && Math.round(k) >= minK,
    `${message}: ${width}x${height} css at dpr ${dpr}`,
  )
  assert.ok(
    Math.abs(height! * dpr - 300 * Math.round(k)) < 0.01,
    `${message}: height ${height} css at dpr ${dpr}`,
  )
  for (const edge of [left, top])
    if (edge !== undefined)
      assert.ok(
        Math.abs(edge * dpr - Math.round(edge * dpr)) < 0.03,
        `${message}: canvas origin ${left},${top} css at dpr ${dpr}`,
      )
}
// k of a measured canvas, for the readability checks.
const pixelRatio = ([width]: number[], dpr: number) => Math.round((width! * dpr) / 400)

async function verifyHudStyles(
  hub: StatusHub,
  hud: HudSurface,
  product: ProductShell,
  preload: string,
) {
  const saved = product.snapshot().hudSettings
  const snapshot = hub.snapshotForPresentation
  const originalCursor = screenApi.getCursorScreenPoint
  let fixture: StatusSnapshot = { ...hub.snapshot(), agents: [] }
  let inactive = 0,
    focused = 0,
    stageEvents = 0
  const loaded = new Set<number>()
  const order: string[] = []
  const created = (_event: Electron.Event, win: BrowserWindow) => {
    if (win.getTitle() !== 'CodePulse HUD') return
    const showInactive = win.showInactive.bind(win)
    win.showInactive = () => {
      inactive++
      showInactive()
    }
    win.focus = () => {
      focused++
    }
    win.webContents.on('did-finish-load', () => loaded.add(win.id))
    const send = win.webContents.send.bind(win.webContents)
    win.webContents.send = (channel, ...args) => {
      if (channel === 'codepulse:hud-stage') {
        assert.ok(loaded.has(win.id), 'stage is delivered after load')
        stageEvents++
        order.push('stage')
      }
      send(channel, ...args)
    }
  }
  const getWindow = () =>
    BrowserWindow.getAllWindows().find((win) => win.getTitle() === 'CodePulse HUD')
  const bridge = new BrowserWindow({
    show: false,
    webPreferences: { preload, sandbox: false, contextIsolation: true, nodeIntegration: false },
  })
  await bridge.loadURL('about:blank')
  const invoke = (win: BrowserWindow, call: string) =>
    win.webContents.executeJavaScript(`window.codepulse.${call}`)
  const status = (
    terminalAt: number,
    state = TurnState.DONE,
    lastEventAt = terminalAt,
    patch: Partial<AgentRuntimeState> = {},
  ) => {
    const waiting = state === TurnState.WAITING_PERMISSION || state === TurnState.WAITING_USER_INPUT
    fixture = {
      overall: 'idle',
      updatedAt: Date.now(),
      agents: [
        {
          agentType: 'codex',
          externalSessionId: 'hud-alert-fixture',
          workspacePath: 'F:/fixture/hud-alert',
          state,
          lastEventAt,
          terminalAt: waiting ? undefined : terminalAt,
          externalTurnId: waiting ? 'hud-waiting-turn' : undefined,
          toolName: waiting ? 'Bash' : undefined,
          activity: waiting ? 'Request command' : undefined,
          unread: true,
          toolCallCount: 0,
          needPermission: false,
          needUserInput: false,
          ...patch,
        },
      ],
    }
    hud.broadcast('codepulse:status', fixture)
  }
  hub.snapshotForPresentation = () => fixture
  app.on('browser-window-created', created)
  try {
    product.setHudSettings({ hudStyle: 'island', autoReveal: true })
    assert.equal(
      (await invoke(bridge, 'getHudStage()')).style,
      'island',
      'stage getter works without a HUD window',
    )
    const firstTime = Date.now() - 1000
    const project = hud.snapshot
    let projectionReads = 0
    hud.snapshot = () => {
      projectionReads++
      return project.call(hud)
    }
    status(firstTime)
    assert.equal(projectionReads, 0, 'seeding alerts without a surface does not bind projects')
    hud.snapshot = project
    assert.equal(getWindow(), undefined, 'first observation only seeds alerts')
    status(firstTime + 1, TurnState.ERROR)
    await until(() => hud.isVisible(), 'passive HUD creation')
    let win = getWindow()!
    assert.equal(inactive, 1, 'new alert shows an inactive HUD')
    assert.equal(focused, 0, 'passive creation never focuses')
    assert.equal(stageEvents, 1, 'new window publishes its stage once after load')
    hud.hide()
    status(firstTime + 1, TurnState.ERROR, Date.now())
    assert.equal(hud.isVisible(), false, 'a session scan cannot reopen a manually hidden HUD')
    product.setHudSettings({ autoReveal: false })
    status(firstTime + 2)
    assert.equal(hud.isVisible(), false, 'auto reveal is opt-in')
    product.setHudSettings({ autoReveal: true })
    status(firstTime + 2)
    assert.equal(hud.isVisible(), false, 'enabling auto reveal does not replay an observed alert')
    status(firstTime - 70_000)
    assert.equal(hud.isVisible(), false, 'expired alerts do not reveal')
    win.destroy()
    const beforeHiddenLoad = inactive
    status(firstTime + 3, TurnState.WAITING_PERMISSION)
    win = getWindow()!
    hud.hide()
    await until(() => loaded.has(win.id), 'hidden HUD load')
    await wait(50)
    assert.equal(inactive, beforeHiddenLoad, 'a HUD hidden during load stays hidden')
    assert.equal(hud.isVisible(), false)
    status(firstTime + 4, TurnState.WAITING_PERMISSION, firstTime + 4, {
      externalTurnId: 'waiting-test',
    })
    await until(() => hud.isVisible(), 'new waiting turn reveals HUD')
    hud.hide()
    for (const internal of [
      { sessionSync: true, activityRefresh: true },
      { sessionSync: true },
      undefined,
    ]) {
      fixture.agents = [
        reduce(fixture.agents[0]!, {
          id: 'waiting-token',
          source: 'codex',
          externalSessionId: 'hud-alert-fixture',
          eventType: 'token_snapshot',
          timestamp: Date.now(),
          internal,
          token: { accuracy: 'exact', contextUsedPercent: 40 },
        }).next,
      ]
      hud.broadcast('codepulse:status', fixture)
      assert.equal(
        hud.isVisible(),
        false,
        'token updates cannot reopen an unchanged waiting request',
      )
    }
    fixture.agents = [
      reduce(fixture.agents[0]!, {
        id: 'repeat-permission',
        source: 'codex',
        externalSessionId: 'hud-alert-fixture',
        eventType: 'permission_request',
        toolName: 'Bash',
        message: 'Request command',
        timestamp: Date.now(),
      }).next,
    ]
    hud.broadcast('codepulse:status', fixture)
    assert.equal(hud.isVisible(), false, 'a repeated permission request cannot reopen the HUD')
    status(Date.now(), TurnState.WAITING_PERMISSION, Date.now(), {
      externalTurnId: 'next-waiting-turn',
    })
    assert.equal(hud.isVisible(), true, 'a new waiting turn reveals')
    hud.hide()
    status(Date.now(), TurnState.WAITING_PERMISSION, Date.now(), {
      externalTurnId: 'next-waiting-turn',
      toolName: 'Read',
      activity: 'Same prompt, second hook',
    })
    assert.equal(hud.isVisible(), false, 'a second hook for one prompt cannot reopen the HUD')
    status(Date.now(), TurnState.THINKING, Date.now(), { externalTurnId: 'next-waiting-turn' })
    status(Date.now(), TurnState.WAITING_PERMISSION, Date.now(), {
      externalTurnId: 'next-waiting-turn',
      toolName: 'Read',
    })
    assert.equal(hud.isVisible(), true, 'the next request in a turn reveals')
    hud.hide()
    const realNow = Date.now
    const later = realNow() + 61_000
    try {
      Date.now = () => later
      hud.broadcast('codepulse:status', fixture)
      fixture.agents = [{ ...fixture.agents[0]!, lastEventAt: later }]
      hud.broadcast('codepulse:status', fixture)
      assert.equal(
        hud.isVisible(),
        false,
        'a continuing wait stays seen after 60 seconds and a token bump',
      )
    } finally {
      Date.now = realNow
    }
    status(realNow() - 70_000, TurnState.WAITING_PERMISSION, realNow() - 70_000, {
      externalTurnId: 'old-wait',
    })
    fixture.agents = [{ ...fixture.agents[0]!, lastEventAt: realNow() }]
    hud.broadcast('codepulse:status', fixture)
    assert.equal(
      hud.isVisible(),
      false,
      'a stale request cannot become new through a later token bump',
    )
    assert.equal(
      await invoke(win, "dismissProjectCard('codex','F:/fixture/hud-alert','hud-alert-fixture')"),
      true,
    )
    fixture.agents = [{ ...fixture.agents[0]!, toolName: 'Write', lastEventAt: realNow() }]
    hud.broadcast('codepulse:status', fixture)
    assert.equal(hud.isVisible(), false, 'a dismissed card cannot reveal while its prompt lasts')
    product.setHudSettings({ autoReveal: false, hudStyle: 'panel' })
    hud.open()
    assert.equal(focused, 1, 'explicit open focuses')
    const area = screenApi.getDisplayMatching(win.getBounds()).workArea
    win.setBounds({ x: area.x + 80, y: area.y + 80, width: 470, height: 260 })
    await wait(50)
    const panelBounds = win.getBounds()
    const sizes = {
      island: [508, 460],
      pills: [388, 720],
      edge: [460, 640],
      orb: [448, 504],
    } as const
    for (const style of ['island', 'pills', 'edge', 'orb'] as const) {
      product.setHudSettings({ hudStyle: style, orbPosition: undefined })
      const bounds = win.getBounds()
      // Native coordinate conversion can round a size by one DIP.
      assert.ok(
        Math.abs(bounds.width - Math.min(area.width, sizes[style][0])) <= 1,
        `${style} width: ${JSON.stringify(bounds)}`,
      )
      assert.ok(
        Math.abs(bounds.height - Math.min(area.height, sizes[style][1])) <= 1,
        `${style} height: ${JSON.stringify(bounds)}`,
      )
      assert.equal(win.isResizable(), false, `${style} is fixed-size`)
      assert.equal((await invoke(win, 'getHudStage()')).style, style)
      const visibleBounds =
        style === 'orb'
          ? { ...hudOrbPositionForStage(bounds, hud.debugState().stage), width: 56, height: 56 }
          : bounds
      assert.ok(
        visibleBounds.x >= area.x &&
          visibleBounds.y >= area.y &&
          visibleBounds.x + visibleBounds.width <= area.x + area.width &&
          visibleBounds.y + visibleBounds.height <= area.y + area.height,
        `${style} visible surface stays in the display`,
      )
      if (style !== 'orb') assert.equal(bounds.y, area.y)
      assert.equal(await invoke(win, 'setHudContentHeight(9999)'), false)
      assert.deepEqual(win.getBounds(), bounds, `${style} ignores renderer content height`)
      assert.equal(await invoke(win, 'setHudInteractive(true)'), true)
      assert.equal(hud.debugState().ignoringMouse, false)
      assert.equal(await invoke(win, 'setHudInteractive(false)'), true)
      assert.equal(hud.debugState().ignoringMouse, process.platform !== 'linux')
      assert.equal(
        await invoke(bridge, 'setHudInteractive(true)'),
        false,
        'another window cannot change hit testing',
      )
      assert.equal(
        await invoke(bridge, "hudDrag('start')"),
        false,
        'another window cannot drag the orb',
      )
    }
    let mutations = 0
    const setBounds = win.setBounds.bind(win),
      setMinimumSize = win.setMinimumSize.bind(win),
      setResizable = win.setResizable.bind(win)
    win.setBounds = (...args) => {
      mutations++
      order.push('bounds')
      setBounds(...args)
    }
    win.setMinimumSize = (...args) => {
      mutations++
      setMinimumSize(...args)
    }
    win.setResizable = (...args) => {
      mutations++
      setResizable(...args)
    }
    product.setHudSettings({ hudOpacity: 55 })
    product.setHudSettings({ hudOpacity: 55 })
    assert.equal(mutations, 0, 'unrelated or unchanged settings do no native geometry work')
    product.setHudSettings({ orbPosition: { x: 50000, y: 50000 } })
    const defaultOrb = hudOrbPositionForStage(win.getBounds(), hud.debugState().stage)
    assert.deepEqual(
      defaultOrb,
      { x: area.x + area.width - 48 - 56, y: area.y + 64 },
      'disconnected saved positions use the default',
    )
    const frozen = hud.debugState().stage
    let cursor = { x: defaultOrb.x + 12, y: defaultOrb.y + 15 }
    screenApi.getCursorScreenPoint = () => ({ ...cursor })
    assert.equal(await invoke(win, "hudDrag('move')"), false, 'move requires a drag start')
    assert.equal(await invoke(win, "hudDrag('invalid')"), false)
    assert.equal(await invoke(win, "hudDrag('start')"), true)
    assert.equal(hud.debugState().ignoringMouse, false)
    await invoke(win, 'setHudInteractive(false)')
    assert.equal(hud.debugState().ignoringMouse, false, 'drag stays interactive')
    const start = win.getBounds()
    cursor = { x: area.x + 32 + 12, y: area.y + 32 + 15 }
    await invoke(win, "hudDrag('move')")
    assert.deepEqual(hud.debugState().stage, frozen, 'drag anchors stay frozen during movement')
    assert.ok(
      Math.abs(win.getBounds().width - start.width) <= 1,
      'move preserves width within native DIP rounding',
    )
    assert.ok(
      Math.abs(win.getBounds().height - start.height) <= 1,
      'move preserves height within native DIP rounding',
    )
    const moved = win.getBounds()
    for (let move = 0; move < 12; move++) await invoke(win, "hudDrag('move')")
    assert.equal(win.getBounds().width, moved.width, 'repeated moves do not grow the native window')
    assert.equal(win.getBounds().height, moved.height, 'repeated moves keep the native height')
    const finalOrb = { x: area.x + 32, y: area.y + area.height - 8 - 56 }
    cursor = { x: finalOrb.x + 12, y: finalOrb.y + 15 }
    order.length = 0
    await invoke(win, "hudDrag('end')")
    assert.deepEqual(order, ['stage', 'bounds'], 'end publishes anchors before applying bounds')
    assert.deepEqual(
      hudOrbPositionForStage(win.getBounds(), hud.debugState().stage),
      finalOrb,
      'end reads the final cursor position',
    )
    assert.equal(hud.debugState().stage.anchorH, 'left')
    assert.equal(hud.debugState().stage.anchorV, 'bottom')
    assert.deepEqual(product.snapshot().hudSettings.orbPosition, finalOrb)
    assert.deepEqual(
      shellPreferenceStore(join(output, 'product-shell.json')).read().hudSettings.orbPosition,
      finalOrb,
      'orb position is persisted',
    )
    verifyHudDisplayChanges(hud, product, win)
    win.setBounds = setBounds
    win.setMinimumSize = setMinimumSize
    win.setResizable = setResizable
    product.setHudSettings({ hudStyle: 'panel' })
    assert.deepEqual(win.getBounds(), panelBounds, 'panel position and height are restored')
    assert.equal(win.getBounds().width, 470)
    assert.deepEqual(win.getMinimumSize(), [470, 132])
    assert.equal(win.isResizable(), true)
    assert.equal(hud.debugState().ignoringMouse, false)
    assert.equal(
      await invoke(win, 'setHudInteractive(false)'),
      false,
      'panel never enables click-through',
    )
    assert.equal(await invoke(win, "hudDrag('start')"), false, 'panel is not orb-draggable')
    const getBounds = win.getBounds.bind(win),
      isMinimized = win.isMinimized.bind(win),
      restore = win.restore.bind(win)
    let minimized = true
    win.isMinimized = () => minimized
    win.getBounds = () =>
      minimized ? { x: -32000, y: -32000, width: 100, height: 100 } : getBounds()
    win.restore = () => {
      order.push('restore')
      minimized = false
    }
    win.setBounds = (...args) => {
      order.push('bounds')
      setBounds(...args)
    }
    order.length = 0
    try {
      hud.open()
      assert.deepEqual(
        order,
        ['restore', 'bounds'],
        'panel restores before reading or applying bounds',
      )
      assert.deepEqual(getBounds(), panelBounds)
    } finally {
      win.getBounds = getBounds
      win.isMinimized = isMinimized
      win.restore = restore
      win.setBounds = setBounds
    }
    writeFileSync(
      join(output, 'hud-styles.json'),
      JSON.stringify(
        {
          passed: true,
          styles: 5,
          alertScenarios: 18,
          displayChanges: true,
          restoreBeforeBounds: true,
          stageHandshake: true,
          dragEndCursor: true,
          dragMoves: 13,
          orbPersisted: true,
          panelRestored: true,
          linuxBlocksTransparentArea: process.platform === 'linux',
        },
        null,
        2,
      ),
    )
  } finally {
    hub.snapshotForPresentation = snapshot
    screenApi.getCursorScreenPoint = originalCursor
    product.setHudSettings({ ...saved, hudStyle: 'panel', orbPosition: saved.orbPosition })
    getWindow()?.destroy()
    bridge.destroy()
    app.removeListener('browser-window-created', created)
  }
}

function verifyHudDisplayChanges(hud: HudSurface, product: ProductShell, win: BrowserWindow) {
  const methods = {
    getAllDisplays: screenApi.getAllDisplays,
    getPrimaryDisplay: screenApi.getPrimaryDisplay,
    getDisplayMatching: screenApi.getDisplayMatching,
    getDisplayNearestPoint: screenApi.getDisplayNearestPoint,
  }
  const original = screenApi.getDisplayMatching(win.getBounds())
  const savedPosition = product.snapshot().hudSettings.orbPosition
  const area = {
    ...original.workArea,
    width: original.workArea.width - 120,
    height: original.workArea.height - 120,
  }
  let display = { ...original, workArea: area }
  screenApi.getAllDisplays = () => [display]
  screenApi.getPrimaryDisplay = () => display
  screenApi.getDisplayMatching = () => display
  screenApi.getDisplayNearestPoint = () => display
  try {
    for (const event of ['display-metrics-changed', 'display-removed'] as const) {
      if (event === 'display-removed') display = { ...display, id: display.id + 1, bounds: area }
      screenApi.emit(event, {}, original, ['workArea'])
      const position = event === 'display-removed' ? undefined : savedPosition
      const expected = hudStageForStyle('orb', display, position)
      const actual = win.getBounds()
      for (const field of ['x', 'y', 'width', 'height'] as const)
        assert.ok(
          Math.abs(actual[field] - expected.bounds[field]) <= 1,
          `${event} recomputes ${field}`,
        )
      assert.deepEqual(hud.debugState().stage, expected.stage)
      assert.deepEqual(
        product.snapshot().hudSettings.orbPosition,
        savedPosition,
        'display changes do not overwrite the saved orb position',
      )
    }
  } finally {
    Object.assign(screenApi, methods)
    screenApi.emit('display-metrics-changed', {}, original, ['workArea'])
  }
}

async function verifyHudStop(hub: StatusHub, hud: HudSurface, product: ProductShell) {
  const savedSnapshot = hub.snapshotForPresentation
  const savedSettings = product.snapshot().hudSettings
  try {
    product.setHudSettings({ autoReveal: true, hudStyle: 'island' })
    const fixture: StatusSnapshot = {
      overall: 'attention',
      updatedAt: Date.now(),
      agents: [
        {
          agentType: 'codex',
          externalSessionId: 'quit-fixture',
          externalTurnId: 'quit-turn',
          state: TurnState.WAITING_PERMISSION,
          lastEventAt: Date.now(),
          toolCallCount: 0,
          unread: false,
          needPermission: true,
          needUserInput: false,
        },
      ],
    }
    hub.snapshotForPresentation = () => fixture
    hud.broadcast('codepulse:status', fixture)
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'CodePulse HUD')!
    assert.ok(win, 'quit test starts with a loading HUD')
    const loaded = new Promise<void>((resolve) =>
      win.webContents.once('did-finish-load', () => resolve()),
    )
    const metricsListeners = screenApi.listenerCount('display-metrics-changed')
    const removedListeners = screenApi.listenerCount('display-removed')
    hud.stop()
    hud.stop()
    assert.equal(screenApi.listenerCount('display-metrics-changed'), metricsListeners - 1)
    assert.equal(screenApi.listenerCount('display-removed'), removedListeners - 1)
    await loaded
    await wait(50)
    assert.equal(hud.isVisible(), false, 'quit prevents a pending load from revealing')
    win.destroy()
    fixture.agents[0]!.externalTurnId = 'new-quit-turn'
    hud.broadcast('codepulse:status', fixture)
    hud.open()
    hud.reveal()
    screenApi.emit('display-removed', {}, screenApi.getPrimaryDisplay())
    assert.equal(
      BrowserWindow.getAllWindows().some((w) => w.getTitle() === 'CodePulse HUD'),
      false,
      'quit prevents all HUD creation paths',
    )
    writeFileSync(
      join(output, 'hud-stop.json'),
      JSON.stringify(
        { passed: true, pendingLoad: true, noRecreation: true, listenersRemoved: true },
        null,
        2,
      ),
    )
  } finally {
    hub.snapshotForPresentation = savedSnapshot
    product.setHudSettings({ ...savedSettings, orbPosition: savedSettings.orbPosition })
  }
}

async function runHudStyleSmoke() {
  // Keep the harness alive between window lifecycle cases, as the tray host does.
  app.on('window-all-closed', () => {})
  const host = resolve(process.env.CODEPULSE_SMOKE_ASSETS ?? 'apps/desktop')
  const root = join(output, 'hud-fixture')
  mkdirSync(join(root, 'renderer'), { recursive: true })
  mkdirSync(join(root, 'preload'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}')
  writeFileSync(
    join(root, 'renderer/index.html'),
    '<!doctype html><title>CodePulse HUD</title><style>html,body{background:transparent}</style>',
  )
  const preload = join(root, 'preload/index.js')
  writeFileSync(preload, readFileSync(join(host, 'out/hud/preload/index.js')))
  const hub = new StatusHub()
  let product: ProductShell
  const hud = new HudSurface(
    hub,
    root,
    join(output, 'hud-workspaces.json'),
    () => product?.refresh(),
    () => {},
    (orbPosition) => product.setHudSettings({ orbPosition }),
  )
  hud.registerIpc()
  const store = shellPreferenceStore(join(output, 'product-shell.json'))
  product = new ProductShell(
    store.read(),
    store.write,
    {
      hudAvailable: () => true,
      hudVisible: () => hud.isVisible(),
      standard: () => {},
      hud: () => hud.open(),
      screen: () => {},
      hideStandard: () => {},
      hideHud: () => hud.hide(),
      hudSettingsChanged: (settings) => hud.syncSettings(settings),
    },
    () => {},
  )
  hud.syncSettings(product.snapshot().hudSettings)
  await verifyHudStyles(hub, hud, product, preload)
  await verifyHudStop(hub, hud, product)
  assert.deepEqual(errors, [], 'HUD fixture and preload have no console errors')
  writeFileSync(
    join(output, 'result.json'),
    JSON.stringify({ passed: true, hudStyles: true, rendererAgnostic: true }, null, 2),
  )
  clearTimeout(deadline)
  app.exit(0)
}

app.whenReady().then(async () => {
  try {
    if (process.env.CODEPULSE_SMOKE_HUD_ONLY === '1') return await runHudStyleSmoke()
    // This harness never calls bootstrap/startLocalServer or modifies real hooks.
    const sqlite = new Database(join(output, 'smoke.sqlite'))
    sqlite.exec('CREATE TABLE IF NOT EXISTS smoke (value TEXT)')
    sqlite.prepare('INSERT INTO smoke VALUES (?)').run('isolated')
    assert.equal(sqlite.prepare('SELECT value FROM smoke LIMIT 1').get().value, 'isolated')
    sqlite.close()
    const hub = new StatusHub()
    hub.ingest({
      id: 'shell-fixture',
      source: 'codex',
      eventType: 'prompt_submit',
      externalSessionId: 'shell-ui',
      workspacePath: 'F:/example/codepulse',
      timestamp: Date.now(),
    })
    const before = JSON.stringify(hub.snapshot().agents)
    let config: DeviceDisplayConfig = {
      ...DEFAULT_DEVICE_DISPLAY,
      agents: [...DEFAULT_DEVICE_DISPLAY.agents],
    }
    let inkConnected = true
    let main: BrowserWindow | undefined
    const host = resolve(process.env.CODEPULSE_SMOKE_ASSETS ?? 'apps/desktop')
    const broadcast = (channel: string, payload: unknown) =>
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, payload))
    let publishInk = () => {}
    let product: ProductShell
    const hud = new HudSurface(
      hub,
      join(host, 'out/hud'),
      join(output, 'hud-workspaces.json'),
      () => product?.refresh(),
      () => {},
      (orbPosition) => product.setHudSettings({ orbPosition }),
    )
    hud.registerIpc()
    const screen = new ScreenWorkbenchWindow({
      preload: join(host, 'out/preload/index.js'),
      renderer: join(host, 'out/renderer/index.html'),
      icon: join(host, 'build/icon.png'),
    })
    writeFileSync(join(output, 'window-state.log'), '')
    const configure = screen.configure.bind(screen)
    screen.configure = (id, input) => {
      const before = screen.state()
      const result = configure(id, input)
      appendFileSync(
        join(output, 'window-state.log'),
        JSON.stringify({ id, input, before, result }) + '\n',
      )
      return result
    }
    const store = shellPreferenceStore(join(output, 'product-shell.json'))
    store.write(normalizeShellPreferences({ version: 1, form: 'standard', view: 'overview' }))
    product = new ProductShell(
      store.read(),
      store.write,
      {
        hudAvailable: () => true,
        hudVisible: () => hud.isVisible(),
        standard: () => main?.show(),
        hud: () => hud.open(main?.getBounds()),
        screen: () => screen.open(),
        hideStandard: () => main?.hide(),
        hideHud: () => hud.hide(),
        hudSettingsChanged: (settings) => hud.syncSettings(settings),
      },
      (s) => {
        broadcast('codepulse:shell-status', s)
        publishInk()
      },
    )
    hud.syncSettings(product.snapshot().hudSettings)
    let targetDelay = 0,
      failTarget: string | undefined
    registerProductIpc(
      {
        handle(channel, listener) {
          ipcMain.handle(channel, async (event, ...args) => {
            if (channel === 'codepulse:shell-target' || channel === 'codepulse:shell-navigate') {
              const target =
                channel === 'codepulse:shell-target'
                  ? args[0]
                  : targetForProductView(args[0] as any, product.snapshot().target)
              if (targetDelay) await wait(targetDelay)
              if (target === failTarget) throw Error('TEST FIXTURE: preference write failed')
            }
            return listener(event, ...args)
          })
        },
      },
      product,
      screen,
      (plan) => applyInk({ plan, display: config }, inkApplyDependencies).shell,
    )
    const previewReads: Record<string, number> = {}
    const measuredIpc = {
      handle(channel: string, listener: (...args: any[]) => any) {
        ipcMain.handle(channel, (...args) => {
          previewReads[channel] = (previewReads[channel] ?? 0) + 1
          return listener(...args)
        })
      },
    }
    const readCount = (name: string) => previewReads['codepulse:' + name] ?? 0
    let yuanbaoKey: YuanbaoCredentials | null = null
    const yuanbaoClient = new YuanbaoClient({
      transport: async (_url, init) => {
        // Synthetic transport only: the smoke never sends credentials or requests to Tencent.
        const params = JSON.parse(String(init.body)),
          query = String(params.Query),
          clock = zonedParts(Date.now())
        const dateKey = (offset: number) =>
          new Date(Date.parse(clock.day + 'T00:00:00Z') + offset * 86400000)
            .toISOString()
            .slice(0, 10)
        const name = query.includes('天气')
          ? 'weather-m1'
          : query.includes('金价')
            ? 'gold-m1'
            : query.includes('股价')
              ? 'stock-m1'
              : null
        if (name) {
          const raw = JSON.parse(
            readFileSync(`tests/fixtures/yuanbao/yuanbao-${name}.json`, 'utf8'),
          ).response
          raw.Response.Pages = raw.Response.Pages.map((entry: string) => {
            const page = JSON.parse(entry)
            page.passage = String(page.passage)
              .replaceAll('2026-10-29', dateKey(-1))
              .replaceAll('2026-10-30', clock.day)
              .replaceAll('2026-10-31', dateKey(1))
              .replace(
                /北京时间\d+日\d\d:\d\d/,
                `北京时间${clock.date}日${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`,
              )
              .replace('更新时间：1793345461', `更新时间：${Math.floor(Date.now() / 1000)}`)
            return JSON.stringify(page)
          })
          return new Response(JSON.stringify(raw))
        }
        const year = clock.month >= 10 ? clock.year + 1 : clock.year
        const holiday = query.includes('节假日安排')
        const page = {
          title: holiday ? `国务院办公厅关于${year}年部分节假日安排的通知` : `${query} v2.4 更新`,
          passage: holiday ? '国务院办公厅通知' : 'release 更新',
          date: clock.day,
          site: holiday ? '中国政府网' : '测试发布站',
          url: holiday
            ? 'https://www.gov.cn/synthetic-notice'
            : 'https://example.com/synthetic-release',
        }
        return new Response(
          JSON.stringify({
            Response: {
              Version: 'standard',
              RequestId: 'synthetic-yuanbao-smoke',
              Pages: [JSON.stringify(page)],
            },
          }),
        )
      },
    })
    const ambient = new AmbientService({
      config: {
        ...DEFAULT_AMBIENT,
        enabled: false,
        xEnabled: true,
        memeEnabled: false,
        calendarEnabled: false,
        quietStart: 0,
        quietEnd: 0,
        idleOnly: false,
      },
      status: () => hub.snapshot(),
      key: () => 'fixture-key',
      save: () => {},
      changed: () => {
        broadcast('codepulse:ambient-status', ambient.snapshot())
        publishInk()
      },
      plan: () => product.snapshot().inkPlan,
      automaticAllowed: () => inkFeatureAt(product.snapshot().inkPlan, Date.now()) === 'ambient',
      yuanbaoKey: () => yuanbaoKey,
      yuanbaoClient,
      saveYuanbao: (cache) =>
        writeFileSync(join(output, 'yuanbao-cache.json'), JSON.stringify(cache)),
      saveYuanbaoResponse: (raw) =>
        writeFileSync(join(output, 'yuanbao-last-response.json'), yuanbaoResponseJson(raw)),
      request: async () => ({
        tweets: [
          {
            id: '12345',
            author: { userName: 'Polymarket' },
            text: 'TEST FIXTURE — this is a screen integration test, not a real news post.',
            createdAt: new Date().toISOString(),
            likeCount: 9000,
          },
        ],
      }),
      image: async () => '',
    })
    const projector = createDeviceDisplayProjector(join(output, 'device-order.json'))
    const assistantStore = new AssistantStore(join(output, 'assistant.sqlite'))
    const assistant = new AssistantService({
      store: assistantStore,
      keys: () => ({ llmKey: '', speechAppKey: '', speechToken: '' }),
      provider: new LumaAssistantProvider(
        () => ({ llmKey: '', speechAppKey: '', speechToken: '' }),
        async () => {
          throw Error('No external calls in UI fixtures')
        },
      ),
      save: () => {},
      changed: () => {
        broadcast('codepulse:assistant-status', assistant.snapshot())
        publishInk()
      },
      notify: () => false,
      automaticAllowed: () => inkFeatureAt(product.snapshot().inkPlan, Date.now()) === 'todos',
    })
    const device = (draft?: DeviceDisplayConfig) => ({
      config,
      status: withAmbient(
        projector(hud.snapshot(), draft ?? config),
        draft ? undefined : selectDeskContent(assistant.inkCard(hud.snapshot()), ambient.current()),
      ),
      serverAvailable: false,
    })
    // A synthetic authenticated device exercises connected drafts without binding a server.
    const inkSnapshot = () =>
      computeInkStatus({
        plan: product.snapshot().inkPlan,
        now: Date.now(),
        lastSeenAt: inkConnected ? Date.now() : null,
        serverEnabled: true,
        projected: device().status,
        ambientTemporary: ambient.temporaryInk(),
        assistantUntil: assistant.temporaryInkUntil(),
        ambientPausedReason: ambient.snapshot().pausedReason,
        nextAutoAt: ambient.nextAutoAt(),
      })
    publishInk = () => {
      broadcast('codepulse:ink-status', inkSnapshot())
      broadcast('codepulse:device-display', device())
    }
    const inkApplyDependencies = {
      shell: product,
      ambient,
      readDisplay: () => config,
      writeDisplay: (next: DeviceDisplayConfig) => {
        config = next
      },
      displaySnapshot: () => device(),
      committed: () => {
        broadcast('codepulse:shell-status', product.snapshot())
        broadcast('codepulse:ambient-status', ambient.snapshot())
        publishInk()
      },
    }
    registerAssistantIpc(
      measuredIpc,
      () => ({
        service: assistant,
        setKey: () => assistant.snapshot(),
        close: () => {
          assistant.stop()
          assistantStore.close()
        },
      }),
      () => device().status,
      () => ambient.dismiss(),
    )
    const imageDir = join(output, 'image-library')
    mkdirSync(imageDir, { recursive: true })
    const imageRuntime = createAmbientRuntime(imageDir, {
      status: () => hub.snapshot(),
      changed: () => {},
    })
    registerAmbientIpc(
      measuredIpc,
      {
        service: ambient,
        setKey: () => ambient.snapshot(),
        setYuanbaoKey: (input) => {
          yuanbaoKey = yuanbaoCredentials(input)
          ambient.yuanbao.credentialsChanged()
          return ambient.snapshot()
        },
        importImage: (bytes, name) => {
          const card = imageRuntime.importImage(bytes, name)
          return ambient.addPersonal('image', card.text, card.imageHex)
        },
      },
      () => device().status,
      async () => {},
      () => assistant.clearTemporaryInk(),
    )
    const voiceState = () => ({
      settings: { enabled: false, intervention: true, failures: true },
      supported: true,
      speaking: false,
      error: null,
    })
    const voiceFixture = {
      version: 2,
      desktop: voiceState(),
      ink: { ...voiceState(), deviceAvailable: false },
    }
    const voiceCalls: { operation: 'set' | 'test' | 'stop'; target: 'desktop' | 'ink' }[] = []
    const handlers: Record<string, (...args: any[]) => any> = {
      'ink-status-get': () => inkSnapshot(),
      'ink-apply': (_e, request) => applyInk(request, inkApplyDependencies),
      'ink-temporary-end': () => {
        endInkTemporary(ambient, assistant)
        publishInk()
        return inkSnapshot()
      },
      'work-voice-get': () => voiceFixture,
      'work-voice-set': (_e, target: 'desktop' | 'ink', value) => {
        voiceCalls.push({ operation: 'set', target })
        voiceFixture[target].settings = value
        broadcast('codepulse:work-voice', voiceFixture)
        return voiceFixture
      },
      'work-voice-test': (_e, target: 'desktop' | 'ink') => {
        voiceCalls.push({ operation: 'test', target })
        voiceFixture[target].speaking = true
        broadcast('codepulse:work-voice', voiceFixture)
        return voiceFixture
      },
      'work-voice-stop': (_e, target: 'desktop' | 'ink') => {
        voiceCalls.push({ operation: 'stop', target })
        voiceFixture[target].speaking = false
        broadcast('codepulse:work-voice', voiceFixture)
        return voiceFixture
      },
      'get-status': (event) => (hud.owns(event.sender) ? hud.snapshot() : hub.snapshot()),
      'sync-sessions': (event) => (hud.owns(event.sender) ? hud.snapshot() : hub.snapshot()),
      'detect-agents': () => [],
      'get-update': () => null,
      'get-version': () => '1.4.11',
      'get-notifications': () => false,
      'set-notifications': (_e, v) => v,
      'hud-preview': () => hud.snapshot(),
      'get-usage': () => null,
      'mimo-login-status': () => false,
      'set-locale': (_e, v) => v,
      'set-window-theme': (_e, v) => v,
      'get-device-display': (_e, draft) => device(draft),
      'set-device-display': (_e, value) => {
        config = normalizeDeviceDisplay(value)
        const next = device()
        broadcast('codepulse:device-display', next)
        return next
      },
      'get-device-provisioning': () => ({
        serverAvailable: false,
        scanning: false,
        devices: [],
        displays: [],
        phase: 'idle',
        updatedAt: Date.now(),
      }),
      'start-device-scan': () => ({
        serverAvailable: false,
        scanning: false,
        devices: [],
        displays: [],
        phase: 'idle',
        updatedAt: Date.now(),
      }),
      'stop-device-scan': () => ({
        serverAvailable: false,
        scanning: false,
        devices: [],
        displays: [],
        phase: 'idle',
        updatedAt: Date.now(),
      }),
      ack: () => {
        throw Error('A presentation action must not acknowledge tasks')
      },
    }
    for (const [name, run] of Object.entries(handlers)) measuredIpc.handle('codepulse:' + name, run)
    // Installed-plugin views use their own namespace; keep this fixture offline and credential-free.
    measuredIpc.handle('plugins:list', () => ({
      state: 'offline',
      platformOrigin: '',
      plugins: [],
    }))
    measuredIpc.handle('plugins:logos', () => ({}))
    measuredIpc.handle('plugins:open', () => ({
      error: 'TEST FIXTURE: plugin platform is offline',
    }))
    main = new BrowserWindow({
      show: false,
      frame: false,
      width: 1120,
      height: 780,
      webPreferences: {
        preload: join(host, 'out/preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        offscreen: true,
      },
    })
    // Track the actual heartbeat lifecycle across visibility changes without waiting 30 seconds.
    // CDP's Page commands need a loaded renderer; waiting on them before navigation deadlocks.
    await main.loadFile(join(host, 'out/renderer/index.html'))
    main.webContents.debugger.attach('1.3')
    await main.webContents.debugger.sendCommand('Page.enable')
    await main.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const timers=new Map(), start=window.setInterval.bind(window), stop=window.clearInterval.bind(window);
        window.__smokeHeartbeats=timers;
        window.setInterval=(callback,delay,...args) => { const id=start(callback,delay,...args); timers.set(id,delay); return id };
        window.clearInterval=(id) => { timers.delete(id); return stop(id) };
      })()`,
    })
    await wait(700)
    console.log('SMOKE main renderer loaded; verifying HUD styles')
    await verifyHudStyles(hub, hud, product, join(host, 'out/hud/preload/index.js'))
    product.restore()
    await until(
      () =>
        main!.webContents.executeJavaScript(`Boolean(document.querySelector('.product-control'))`),
      'control',
    )
    // Text-based fixtures explicitly choose Chinese; CI may run an English OS.
    // This writes only the disposable profile, never the user's saved language.
    await main.webContents.executeJavaScript(`localStorage.setItem('codepulse:locale','zh')`)
    await main.loadFile(join(host, 'out/renderer/index.html'))
    await until(
      () =>
        main!.webContents.executeJavaScript(`Boolean(document.querySelector('.product-control'))`),
      'Chinese control reload',
    )
    assert.ok(
      await main.webContents.executeJavaScript(
        `document.querySelector('[data-view=window]').textContent.includes('工作台')`,
      ),
      'Chinese fixture locale',
    )
    assert.equal(product.snapshot().view, 'window', 'legacy overview follows the selected surface')
    assert.equal(
      await main.webContents.executeJavaScript(
        `Boolean(document.querySelector('.product-topbar'))`,
      ),
      false,
    )
    await main.webContents.executeJavaScript(
      `localStorage.setItem('codepulse:dashboard-settings',JSON.stringify({...JSON.parse(localStorage.getItem('codepulse:dashboard-settings')||'{}'),theme:'light'}))`,
    )
    await main.webContents.reload()
    await wait(900)
    await until(
      () =>
        main!.webContents.executeJavaScript(`Boolean(document.querySelector('.product-control'))`),
      'control reload',
    )
    let firstCapture = true
    const capture = async (name: string, fresh = false) => {
      if (!captureAll) return
      // Scrolled settings evidence must discard the hidden window's previous frame as well.
      if (firstCapture || fresh) {
        await main!.webContents.capturePage()
        firstCapture = false
      }
      await wait(80)
      writeFileSync(join(output, name + '.png'), (await main!.webContents.capturePage()).toPNG())
    }
    const selectPlayback = async (value: string) => {
      await main!.webContents.executeJavaScript(
        `(() => {const s=document.querySelector('.ink-playback-select');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`,
      )
      await wait()
    }
    // Every physical pixel under the preview canvas, edges included, must be paper, ink or red:
    // a fractional canvas size or phase resamples the last row/column into blends like #E1AFB1.
    const assertCanvasPure = async (
      label: string,
      selector = '.ambient-panel .device-preview canvas.device-screen',
    ) => {
      await main!.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',inline:'center'})`,
      )
      await wait(400)
      const box = (await main!.webContents.executeJavaScript(
        `(()=>{const c=document.querySelector(${JSON.stringify(selector)});c.scrollIntoView({block:'center',inline:'center'});const r=c.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height,dpr:window.devicePixelRatio}})()`,
      )) as { x: number; y: number; w: number; h: number; dpr: number }
      const image = await main!.webContents.capturePage(),
        size = image.getSize(),
        bitmap = image.toBitmap()
      const left = Math.round(box.x * box.dpr),
        top = Math.round(box.y * box.dpr),
        width = Math.round(box.w * box.dpr),
        height = Math.round(box.h * box.dpr)
      assert.ok(
        left >= 0 && top >= 0 && left + width <= size.width && top + height <= size.height,
        label + ': canvas is inside the capture ' + JSON.stringify({ box, size }),
      )
      const colours = new Map<string, number>(),
        bad = new Map<string, string>()
      for (let y = top; y < top + height; y++)
        for (let x = left; x < left + width; x++) {
          const i = (y * size.width + x) * 4,
            key = [bitmap[i + 2], bitmap[i + 1], bitmap[i]]
              .map((v) => v!.toString(16).padStart(2, '0'))
              .join('')
          colours.set(key, (colours.get(key) ?? 0) + 1)
          if (!['ffffff', '000000', 'be1e2d'].includes(key) && bad.size < 6)
            bad.set(key, `${x - left},${y - top}`)
        }
      if (bad.size)
        writeFileSync(
          join(output, 'canvas-edge-' + label.replace(/\W+/g, '-') + '.png'),
          image.toPNG(),
        )
      assert.equal(
        bad.size,
        0,
        label +
          ': canvas pixels outside {white, black, red} at dpr ' +
          box.dpr +
          ' css ' +
          box.w +
          'x' +
          box.h +
          ' (first at x,y): ' +
          JSON.stringify([...bad]) +
          ' box ' +
          JSON.stringify({ left, top, width, height, size }),
      )
    }
    await capture('control-desktop')
    // The live workbench keeps room for a full agent panel (header, quota, a session card) and scrolls inside the stage.
    for (const [width, height] of [
      [720, 480],
      [1024, 768],
    ] as const) {
      main.setContentSize(width, height)
      await wait(450)
      const stage = (await main.webContents.executeJavaScript(
        `(() => {const s=document.querySelector('.product-console-live-stage'),m=s.querySelector('main'),p=m.querySelector(':scope > .grid > *');return {stage:s.getBoundingClientRect().height,panel:p.getBoundingClientRect().height,scroll:m.scrollHeight-m.clientHeight,overflow:document.documentElement.scrollWidth-window.innerWidth}})()`,
      )) as { stage: number; panel: number; scroll: number; overflow: number }
      assert.ok(
        stage.stage >= 480 && stage.panel >= 420,
        'workbench stage keeps a usable height at ' + width + ': ' + JSON.stringify(stage),
      )
      assert.ok(stage.overflow <= 1, 'no horizontal page scroll on the desktop tab at ' + width)
      await capture('control-desktop-' + width)
    }
    main.setContentSize(1120, 780)
    await wait(350)
    // The e-ink state is a mark on the sidebar's device row; there is no banner, no pill and no live-console footer.
    assert.equal(
      await main.webContents.executeJavaScript(
        `Boolean(document.querySelector('.ink-status, .ink-status-slot'))`,
      ),
      false,
      'no status banner',
    )
    assert.match(
      await main.webContents.executeJavaScript(
        `document.querySelector('.product-rail [data-view=ink]')?.getAttribute('aria-label')??''`,
      ),
      /^墨水屏设备，.+/,
      'the device row names the e-ink state',
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelectorAll('.product-rail .product-nav-status').length`,
      ),
      1,
      'the e-ink state is one mark on the device row',
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelectorAll('.product-rail .product-brand, .ink-pill').length`,
      ),
      0,
      'the sidebar has neither a brand row nor a status pill',
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.body.innerText.includes('助手分屏')||document.body.innerText.includes('本地服务')`,
      ),
      false,
      'footer strip and rail caption are gone',
    )
    // Desktop has one live workbench and no header actions; the stored layout stays compatible.
    assert.equal(
      await main.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.product-control button')).filter(b=>b.textContent.includes('功能平铺')).length`,
      ),
      0,
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelectorAll('.product-control .page-header button').length`,
      ),
      0,
      'the workbench has no redundant header action row',
    )
    // The sidebar's selected row already names the page: the title is a screen-reader heading and nothing repeats the state.
    assert.deepEqual(
      await main.webContents.executeJavaScript(`(() => {
        const h=document.querySelector('.product-control h1'),box=h.getBoundingClientRect();
        return {text:h.textContent, hidden:h.classList.contains('page-sr'), width:box.width, height:box.height,
          subtitles:document.querySelectorAll('.product-control .page-header p').length};
      })()`),
      { text: '工作台', hidden: true, width: 1, height: 1, subtitles: 0 },
    )
    // The sidebar heading sits below the native buttons. Its spacing and row are both draggable.
    const platform = (await main.webContents.executeJavaScript(
      'window.codepulse.platform',
    )) as string
    const rgb = (hex: string) => {
      const n = parseInt(hex.slice(1), 16)
      return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`
    }
    type Zone = { top: number; height: number; drag: string } | null
    const shellTop = (await main.webContents.executeJavaScript(`(() => {
      const zone=(selector) => { const el=document.querySelector(selector); if(!el) return null; const box=el.getBoundingClientRect(); return {top:box.top,height:box.height,drag:getComputedStyle(el).getPropertyValue('-webkit-app-region')} };
      const overlay=navigator.windowControlsOverlay, area=overlay&&overlay.visible?overlay.getTitlebarAreaRect():null;
      return {strips:document.querySelectorAll('.window-titlebar').length, heading:zone('.product-rail-heading'), row:zone('.product-rail-top'), band:zone('.product-dragbar'),
        logo:Boolean(document.querySelector('.product-rail-logo')), name:document.querySelector('.product-rail-name')?.textContent??null,
        content:zone('.product-console-live-stage'), area:area&&{height:area.height,bottom:area.y+area.height},
        topBorder:getComputedStyle(document.querySelector('#root > .app-shell')).borderTopWidth,
        mainBackground:getComputedStyle(document.querySelector('.product-main')).backgroundColor};
    })()`)) as {
      strips: number
      row: Zone
      heading: Zone
      band: Zone
      logo: boolean
      name: string | null
      content: Zone
      area: { height: number; bottom: number } | null
      topBorder: string
      mainBackground: string
    }
    assert.equal(shellTop.strips, 0, 'no strip across the window')
    assert.equal(
      shellTop.mainBackground,
      rgb(windowChromePalette('light').overlayColor),
      'light: the caption buttons blend with the main area',
    )
    if (platform === 'win32') {
      const { heading, row, band, content } = shellTop
      assert.ok(heading && row && band && content, JSON.stringify(shellTop))
      assert.deepEqual([heading.drag, row.drag, band.drag], ['drag', 'drag', 'drag'])
      assert.equal(row.height, 40)
      assert.equal(heading.height, 52)
      assert.ok(Math.abs(row.top - heading.top - 12) < 0.5, 'the heading has 12px top spacing')
      assert.equal(shellTop.topBorder, '0px', 'the Windows top edge has no separator')
      assert.deepEqual([shellTop.logo, shellTop.name], [true, 'CodePulse'])
      assert.ok(content.top >= band.top + band.height, 'workbench content clears the caption strip')
      assert.notEqual(content.drag, 'drag')
      if (shellTop.area)
        assert.ok(content.top >= shellTop.area.bottom, 'outside the caption buttons')
      else
        console.log('SMOKE windowControlsOverlay is unavailable here; caption-button area skipped')
      console.log(
        'SMOKE frameless fixture reserved title bar height',
        band.height,
        'CSS px; native overlay height',
        shellTop.area?.height ?? 'unavailable',
      )
    } else {
      assert.equal(shellTop.band, null, 'the native title bar needs no drag band')
      assert.deepEqual([shellTop.logo, shellTop.name], [false, null], 'no brand beside it')
    }
    await capture('shell-top-light')
    // The sidebar collapses to icons from its toggle or Ctrl+B, remembers the choice and keeps every accessible name.
    // The hidden window is never focused or hovered by the OS, so the page borrows both from the debugger.
    type RailState = {
      width: number
      collapsed: boolean
      expanded: string | null
      label: string | null
      stored: string | null
    }
    const railState = () =>
      main!.webContents.executeJavaScript(`(() => {
        const rail=document.querySelector('.product-rail'),toggle=document.querySelector('.product-rail-toggle');
        return {width:rail.getBoundingClientRect().width, collapsed:rail.classList.contains('is-collapsed'),
          expanded:toggle.getAttribute('aria-expanded'), label:toggle.getAttribute('aria-label'),
          stored:localStorage.getItem('codepulse.railCollapsed')};
      })()`) as Promise<RailState>
    const railNames = () =>
      main!.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.product-rail button[data-view]')).map(b=>[b.dataset.view,b.getAttribute('aria-label')??Array.from(b.childNodes).filter(n=>n.nodeType===3||n.getAttribute('aria-hidden')!=='true').map(n=>n.textContent).join('').trim()])`,
      ) as Promise<string[][]>
    const railWidth = (expected: number, description: string) =>
      until(async () => Math.abs((await railState()).width - expected) < 0.5, description)
    // [visibility, text] of the tooltip that belongs to a control.
    const railTip = (control: string) =>
      main!.webContents.executeJavaScript(
        `(() => { const control=document.querySelector(${JSON.stringify(control)}),tip=control.querySelector(':scope > .product-tip')??control.parentElement.querySelector(':scope > .product-tip'); return [getComputedStyle(tip).visibility, tip.textContent] })()`,
      ) as Promise<[string, string]>
    const toggleFocus = () =>
      main!.webContents.executeJavaScript(`(() => {
        const toggle=document.querySelector('.product-rail-toggle'),style=getComputedStyle(toggle);
        return {focused:document.activeElement===toggle, visible:toggle.matches(':focus-visible'), outline:style.outlineStyle+' '+style.outlineWidth};
      })()`) as Promise<{ focused: boolean; visible: boolean; outline: string }>
    const inspector = main.webContents.debugger
    if (!inspector.isAttached()) inspector.attach('1.3')
    await inspector.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    const centre = (selector: string) =>
      main!.webContents.executeJavaScript(
        `(() => { const box=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:box.left+box.width/2, y:box.top+box.height/2} })()`,
      ) as Promise<{ x: number; y: number }>
    const hover = async (selector: string) => {
      await inspector.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        ...(await centre(selector)),
      })
      await wait(120)
    }
    // A real mouse click: it carries a click count, which a script's .click() does not.
    const mouseClick = async (selector: string) => {
      const point = await centre(selector)
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const)
        await inspector.sendCommand('Input.dispatchMouseEvent', {
          type,
          ...point,
          button: 'left',
          clickCount: 1,
        })
      await wait(120)
    }
    const pressKey = async (keyCode: string, modifiers: ('control' | 'shift' | 'meta')[] = []) => {
      for (const type of ['keyDown', 'keyUp'] as const)
        main!.webContents.sendInputEvent({ type, keyCode, modifiers })
      await wait(120)
    }
    const shortcut = platform === 'darwin' ? '⌘B' : 'Ctrl+B'
    const shortcutModifiers: ('control' | 'meta')[] = [platform === 'darwin' ? 'meta' : 'control']
    await main.webContents.executeJavaScript(`(() => {
      const query=document.querySelectorAll.bind(document);window.__smokeModalQueries=0;
      document.querySelectorAll=(selector) => { if(selector==='[aria-modal="true"]') window.__smokeModalQueries++; return query(selector) };
      window.__restoreSmokeModalQuery=() => { document.querySelectorAll=query };
    })()`)
    await pressKey('A')
    await pressKey('B')
    assert.equal(
      await main.webContents.executeJavaScript('window.__smokeModalQueries'),
      0,
      'unrelated keys never query modal layout',
    )
    await main.webContents.executeJavaScript('window.__restoreSmokeModalQuery()')
    const expandedRail = await railState()
    assert.ok(expandedRail.width > 56 && !expandedRail.collapsed, JSON.stringify(expandedRail))
    assert.deepEqual(
      [expandedRail.expanded, expandedRail.label, expandedRail.stored],
      ['true', '收起侧边栏', '0'],
    )
    const expandedNames = await railNames()
    assert.equal(expandedNames.length, 6, 'five pages and Settings')
    const navigationTops = () =>
      main!.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.product-rail nav button')).map(row=>row.getBoundingClientRect().top)`,
      ) as Promise<number[]>
    const expandedTops = await navigationTops()
    // Both language choices and the separator stay opaque; color and weight identify the current one.
    const languageStyles = await main.webContents.executeJavaScript(`(() => {
        const read=(selector) => { const style=getComputedStyle(document.querySelector(selector)); return [style.opacity, style.fontWeight, style.color] };
        return {current:read('.product-language-toggle [data-active=true]'),secondary:read('.product-language-toggle [data-active=false]'),
          separator:read('.product-language-toggle > span[aria-hidden=true]:not(.product-tip)'),ink700:getComputedStyle(document.querySelector('.product-rail')).getPropertyValue('--ink-700').trim()};
      })()`)
    assert.deepEqual(languageStyles.current, [
      '1',
      '600',
      rgb(windowChromePalette('light').symbolColor),
    ])
    assert.deepEqual(languageStyles.secondary, ['1', '400', rgb(languageStyles.ink700)])
    assert.deepEqual(languageStyles.separator, ['1', '400', rgb(languageStyles.ink700)])
    // Expanded, only the switch and the device row carry a tooltip.
    await hover('.product-rail-toggle')
    assert.deepEqual(await railTip('.product-rail-toggle'), ['visible', `收起侧边栏 · ${shortcut}`])
    await hover('.product-rail [data-view=overlay]')
    assert.deepEqual(await railTip('.product-rail [data-view=overlay]'), ['hidden', '悬浮窗'])
    await hover('.product-rail [data-view=ink]')
    const [markVisibility, markTip] = await railTip('.product-rail [data-view=ink]')
    assert.ok(markVisibility === 'visible' && markTip.startsWith('墨水屏设备，'), markTip)
    // A real mouse click collapses the sidebar and leaves no focus ring on the switch.
    await mouseClick('.product-rail-toggle')
    await railWidth(56, 'the toggle collapses the sidebar to 56px')
    const collapsedRail = await railState()
    assert.deepEqual(
      [collapsedRail.collapsed, collapsedRail.expanded, collapsedRail.label, collapsedRail.stored],
      [true, 'false', '展开侧边栏', '1'],
    )
    assert.equal((await toggleFocus()).focused, false, 'a mouse click lets go of the switch')
    assert.deepEqual(
      await navigationTops(),
      expandedTops,
      'collapsing never shifts the icon column vertically',
    )
    assert.deepEqual(await railNames(), expandedNames, 'collapsing keeps every accessible name')
    assert.deepEqual(
      await main.webContents.executeJavaScript(`(() => {
        const clipped=(el) => { const style=getComputedStyle(el),box=el.getBoundingClientRect(); return style.display!=='none' && style.visibility!=='hidden' && box.width<=1 && box.height<=1 };
        const name=document.querySelector('.product-rail-name'),logo=document.querySelector('.product-rail-logo');
        return {
          labelsClipped: Array.from(document.querySelectorAll('.product-rail .product-nav-label')).every(clipped),
          nameClipped: name ? clipped(name) : null,
          logoShown: logo ? getComputedStyle(logo).display!=='none' : null,
          language: document.querySelector('.product-language-toggle').innerText.trim(),
          stacked: getComputedStyle(document.querySelector('.product-settings-row')).flexDirection,
          overflow: document.documentElement.scrollWidth-window.innerWidth,
        };
      })()`),
      {
        labelsClipped: true,
        nameClipped: platform === 'win32' ? true : null,
        logoShown: platform === 'win32' ? false : null,
        language: '中',
        stacked: 'column',
        overflow: 0,
      },
    )
    // Ctrl+B right after a click: the switch is not focused, so no focus ring shows.
    await pressKey('B', shortcutModifiers)
    await railWidth(expandedRail.width, 'Ctrl+B expands the sidebar')
    assert.deepEqual(await railState(), { ...expandedRail, stored: '0' })
    assert.deepEqual(await toggleFocus(), {
      focused: false,
      visible: false,
      outline: (await toggleFocus()).outline,
    })
    // Tabbing onto the switch keeps its focus ring, and Enter keeps it there.
    await main.webContents.executeJavaScript(
      `document.querySelector('.product-rail [data-view=window]').focus()`,
    )
    await pressKey('Tab', ['shift'])
    const tabbed = await toggleFocus()
    assert.ok(
      tabbed.focused && tabbed.visible && tabbed.outline.startsWith('solid 2px'),
      JSON.stringify(tabbed),
    )
    main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    main.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    main.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await railWidth(56, 'Enter on the focused switch collapses the sidebar')
    const kept = await toggleFocus()
    assert.ok(
      kept.focused && kept.visible,
      'the keyboard keeps the focus ring: ' + JSON.stringify(kept),
    )
    await main.webContents.executeJavaScript(`document.activeElement.blur()`)
    // Collapsed, hovering or tabbing onto an icon shows its name and the other icons stay quiet.
    await hover('.product-rail [data-view=overlay]')
    assert.deepEqual(await railTip('.product-rail [data-view=overlay]'), ['visible', '悬浮窗'])
    assert.equal((await railTip('.product-rail [data-view=usage]'))[0], 'hidden')
    await capture('rail-collapsed')
    await hover('.product-rail-toggle')
    assert.deepEqual(await railTip('.product-rail-toggle'), ['visible', `展开侧边栏 · ${shortcut}`])
    await hover('.product-rail [data-view=ink]')
    assert.equal(
      (await railTip('.product-rail [data-view=ink]'))[1].startsWith('墨水屏设备，'),
      true,
    )
    // Escape hides the tooltips until the pointer leaves the sidebar, and is left alone otherwise.
    await main.webContents.executeJavaScript(
      `window.addEventListener('keydown', (event) => { if (event.key==='Escape') window.__escapeUsed = event.defaultPrevented })`,
    )
    const escapeUsed = () => main!.webContents.executeJavaScript(`window.__escapeUsed`)
    const dismissed = () =>
      main!.webContents.executeJavaScript(`'tipsDismissed' in document.documentElement.dataset`)
    await hover('.product-rail [data-view=overlay]')
    await pressKey('Escape')
    assert.equal(await escapeUsed(), true, 'Escape is taken while a tooltip shows')
    assert.deepEqual(await railTip('.product-rail [data-view=overlay]'), ['hidden', '悬浮窗'])
    await hover('.product-rail [data-view=usage]')
    assert.equal((await railTip('.product-rail [data-view=usage]'))[0], 'hidden', 'still dismissed')
    assert.equal(await dismissed(), true)
    await inspector.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 300 })
    await wait(120)
    assert.equal(await dismissed(), false, 'leaving the sidebar ends the dismissal')
    await pressKey('Escape')
    assert.equal(await escapeUsed(), false, 'with no tooltip showing Escape is not ours')
    await hover('.product-rail [data-view=overlay]')
    assert.equal((await railTip('.product-rail [data-view=overlay]'))[0], 'visible')
    await inspector.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 300 })
    // Tabbing: Escape hides the focused icon's name; the next icon shows its own.
    await main.webContents.executeJavaScript(
      `document.querySelector('.product-rail [data-view=window]').focus()`,
    )
    await pressKey('Tab')
    assert.equal(
      await main.webContents.executeJavaScript(`document.activeElement.dataset.view`),
      'overlay',
    )
    assert.deepEqual(await railTip('.product-rail [data-view=overlay]'), ['visible', '悬浮窗'])
    assert.equal((await railTip('.product-rail [data-view=usage]'))[0], 'hidden')
    await pressKey('Escape')
    assert.equal((await railTip('.product-rail [data-view=overlay]'))[0], 'hidden')
    await pressKey('Tab')
    assert.equal((await railTip('.product-rail [data-view=ink]'))[0], 'visible', 'next icon')
    await main.webContents.executeJavaScript(`document.activeElement.blur()`)
    // Ctrl+B keeps working from the keyboard; a text field owns it, a checkbox does not.
    await pressKey('B', shortcutModifiers)
    await railWidth(expandedRail.width, 'Ctrl+B expands the sidebar again')
    assert.equal((await railState()).stored, '0')
    await pressKey('B', shortcutModifiers)
    await railWidth(56, 'Ctrl+B collapses the sidebar')
    assert.equal((await railState()).stored, '1')
    for (const [type, toggles] of [
      ['text', false],
      ['checkbox', true],
      ['radio', true],
      ['range', true],
      ['button', true],
      ['select', true],
    ] as const) {
      await main.webContents.executeJavaScript(
        `(() => { const type=${JSON.stringify(type)}, probe=document.createElement(type==='select'?'select':'input'); if(type!=='select') probe.type=type; probe.id='rail-shortcut-probe'; document.body.append(probe); probe.focus() })()`,
      )
      const before = (await railState()).collapsed
      await pressKey('B', shortcutModifiers)
      assert.equal(
        (await railState()).collapsed,
        toggles ? !before : before,
        `${type} fields ${toggles ? 'pass' : 'keep'} Ctrl+B`,
      )
      await main.webContents.executeJavaScript(
        `document.getElementById('rail-shortcut-probe').remove()`,
      )
    }
    const beforeModal = (await railState()).collapsed
    await main.webContents.executeJavaScript(
      `(() => { const modal=document.createElement('div'); modal.id='rail-modal-probe'; modal.setAttribute('aria-modal','true'); modal.textContent='Modal fixture'; document.body.append(modal) })()`,
    )
    await pressKey('B', shortcutModifiers)
    assert.equal((await railState()).collapsed, beforeModal, 'a visible modal owns the shortcut')
    await main.webContents.executeJavaScript(
      `document.getElementById('rail-modal-probe').hidden=true`,
    )
    await pressKey('B', shortcutModifiers)
    assert.equal(
      (await railState()).collapsed,
      !beforeModal,
      'a hidden modal leaves the shortcut available',
    )
    await main.webContents.executeJavaScript(`document.getElementById('rail-modal-probe').remove()`)
    // Restore the expanded state after the input and modal probes.
    if ((await railState()).collapsed) await pressKey('B', shortcutModifiers)
    await railWidth(expandedRail.width, 'the sidebar is expanded again')
    assert.equal((await railState()).stored, '0')
    // A narrow window keeps the same expanded width; it must still collapse without horizontal scroll.
    main.setContentSize(720, 600)
    await wait(350)
    await click(main, '.product-rail-toggle')
    await railWidth(56, 'the sidebar collapses in a narrow window')
    assert.deepEqual(
      await main.webContents.executeJavaScript(
        `({page: document.documentElement.scrollWidth-window.innerWidth, content: document.querySelector('.product-scroll').scrollWidth-document.querySelector('.product-scroll').clientWidth})`,
      ),
      { page: 0, content: 0 },
      'no horizontal scroll with a collapsed sidebar at 720px',
    )
    await capture('rail-collapsed-720')
    await click(main, '.product-rail-toggle')
    await railWidth(200, 'the narrow sidebar expands to 200px')
    main.setContentSize(1120, 780)
    await wait(350)
    assert.deepEqual(
      await railState(),
      { ...expandedRail, stored: '0' },
      'the sidebar ends expanded',
    )
    // The grouped rail, status and connection badge are measured in both themes and both states.
    const railLayouts: unknown[] = []
    const captionLayouts: unknown[] = []
    const verifyRail = async (collapsed: boolean) => {
      const layout = await main!.webContents.executeJavaScript(`(() => {
        const rail=document.querySelector('.product-rail'), current=rail.querySelector('[aria-current=page]'),
          pill=rail.querySelector('.product-rail-status'), text=pill.querySelector('.product-rail-status-text'),
          dot=pill.querySelector('.product-rail-status-dot'), settings=rail.querySelector('.product-settings-row'),
          device=rail.querySelector('[data-view=ink]'), glyph=device.querySelector('.product-nav-glyph'),
          mark=device.querySelector('.product-nav-status'), g=glyph.getBoundingClientRect(), m=mark.getBoundingClientRect(),
          p=pill.getBoundingClientRect(), t=text.getBoundingClientRect(), style=getComputedStyle(current),
          groups=Array.from(rail.querySelectorAll('.product-nav-group'));
        return {width:rail.getBoundingClientRect().width,viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,theme:document.documentElement.dataset.theme,
          groups:groups.map(group=>({role:group.getAttribute('role'),labelled:group.getAttribute('aria-labelledby')===group.firstElementChild.id,
            text:group.firstElementChild.textContent,font:getComputedStyle(group.firstElementChild).fontSize,
            color:getComputedStyle(group.firstElementChild).color,visible:getComputedStyle(group.firstElementChild).visibility==='visible'})),
          muted:getComputedStyle(rail).getPropertyValue('--ink-muted').trim(),
          groupInk:getComputedStyle(rail).getPropertyValue('--rail-group-ink').trim(),
          current:{font:style.fontSize,weight:style.fontWeight,height:current.getBoundingClientRect().height,
            icon:current.querySelector('svg').getBoundingClientRect().width,radius:style.borderRadius,shadow:style.boxShadow,
            row:style.getPropertyValue('--row-bg').trim(),solid:style.getPropertyValue('--surface-solid').trim()},
          marker:{pinned:Math.abs(m.left+m.width/2-g.right)<.5&&Math.abs(m.top-g.top+4)<.5,
            border:getComputedStyle(mark).borderTopColor,background:getComputedStyle(mark).backgroundColor,row:getComputedStyle(device).backgroundColor,
            hollow:mark.classList.contains('is-hollow')},
          status:{text:text.textContent,height:p.height,role:pill.getAttribute('role'),
            overflow:text.scrollWidth-text.clientWidth,clipped:t.width<=1&&t.height<=1,dot:[dot.getBoundingClientRect().width,dot.getBoundingClientRect().height],
            beforeSettings:p.bottom<=settings.getBoundingClientRect().top,inside:p.left>=0&&p.right<=rail.getBoundingClientRect().right&&p.bottom<=innerHeight,
            footerInside:Array.from(settings.querySelectorAll('button')).every(button=>button.getBoundingClientRect().bottom<=innerHeight)},
          children:rail.querySelectorAll('.product-nav-child,[data-parent],[data-section-active]').length,
          overflow:document.documentElement.scrollWidth-innerWidth};
      })()`)
      assert.equal(layout.width, collapsed ? 56 : 200)
      assert.deepEqual(
        layout.groups.map((group: { text: string }) => group.text),
        ['工作空间', '设备与扩展', '数据分析'],
      )
      for (const group of layout.groups) {
        assert.equal(group.role, 'group')
        assert.equal(group.labelled, true)
        assert.equal(group.font, '12px')
        assert.equal(group.color, rgb(layout.groupInk))
        assert.equal(group.visible, !collapsed)
      }
      assert.deepEqual(
        [
          layout.current.font,
          layout.current.weight,
          layout.current.height,
          layout.current.icon,
          layout.current.radius,
        ],
        ['14px', '600', 36, 18, '8px'],
      )
      assert.equal(layout.current.row, layout.current.solid)
      assert.match(layout.current.shadow, /0px 0px 0px 1px inset/)
      assert.doesNotMatch(
        layout.current.shadow,
        /3px 0px 0px 0px inset/,
        'no inset left selection bar',
      )
      assert.equal(layout.children, 0, 'plugins and the device stay peers')
      assert.equal(layout.marker.pinned, true, 'the status mark stays on the icon corner')
      if (layout.marker.hollow) {
        assert.equal(layout.marker.border, rgb(layout.muted))
        assert.equal(layout.marker.background, layout.marker.row)
      }
      assert.deepEqual([layout.status.role, layout.status.dot], ['status', [8, 8]])
      assert.ok(layout.status.height >= 32, 'status text can grow beyond one line')
      assert.equal(
        layout.status.beforeSettings && layout.status.inside,
        true,
        JSON.stringify(layout.status),
      )
      assert.equal(
        layout.status.footerInside,
        true,
        'every footer control fits below the lowered heading',
      )
      assert.match(layout.status.text, /^运行正常 · (?:空闲|\d+ 个任务执行中)$/)
      if (collapsed) {
        assert.equal(layout.status.clipped, true)
        assert.equal(layout.status.height, 32)
      } else
        assert.ok(
          layout.status.overflow <= 1,
          'the full status fits: ' + JSON.stringify(layout.status),
        )
      assert.equal(layout.overflow, 0)
      railLayouts.push({ collapsed, ...layout })
    }
    for (const theme of ['light', 'dark'] as const) {
      await click(main, '[data-view=settings]')
      await click(main, `.theme-swatch-${theme}`)
      await openCurrentSurface(main)
      // The full screenshot matrix is opt-in; the default keeps every assertion at the minimum size.
      for (const [width, height] of captureAll
        ? [
            [1440, 900],
            [1024, 768],
            [720, 480],
          ]
        : [[720, 480]]) {
        main.setContentSize(width!, height!)
        await wait(200)
        await verifyRail(false)
        const tops = await navigationTops()
        await capture(`rail-${theme}-expanded-${width}`)
        await mouseClick('.product-rail-toggle')
        await railWidth(56, 'collapsed acceptance rail')
        await verifyRail(true)
        assert.deepEqual(
          await navigationTops(),
          tops,
          'group spacing keeps the icon column aligned',
        )
        await hover('.product-rail-status')
        assert.equal((await railTip('.product-rail-status'))[0], 'visible')
        await main.webContents.executeJavaScript(
          `document.querySelector('.product-rail [data-view=usage]').focus()`,
        )
        await pressKey('Tab')
        assert.equal(
          await main.webContents.executeJavaScript(
            `document.activeElement.classList.contains('product-rail-status')`,
          ),
          true,
        )
        assert.equal(
          (await railTip('.product-rail-status'))[0],
          'visible',
          'keyboard focus explains the status dot',
        )
        await main.webContents.executeJavaScript(`document.activeElement.blur()`)
        await inspector.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: width! - 100,
          y: 300,
        })
        await capture(`rail-${theme}-collapsed-${width}`)
        await mouseClick('.product-rail-toggle')
        await railWidth(200, 'expanded acceptance rail')
      }
      if (platform === 'win32') {
        const chrome = await main.webContents.executeJavaScript(`(() => {
          const band=document.querySelector('.product-dragbar'),content=document.querySelector('.product-content');
          return {background:getComputedStyle(band).backgroundColor,bottom:band.getBoundingClientRect().bottom,contentTop:content.getBoundingClientRect().top};
        })()`)
        assert.equal(
          chrome.background,
          rgb(windowChromePalette(theme).overlayColor),
          `${theme} caption strip matches the overlay`,
        )
        assert.ok(chrome.contentTop >= chrome.bottom, 'page content starts below the caption strip')
        captionLayouts.push({ theme, ...chrome })
        await capture(`caption-top-${theme}`)
      }
    }
    main.setContentSize(940, 720)
    await wait(200)
    await verifyRail(false)
    main.setContentSize(1120, 780)
    await click(main, '[data-view=settings]')
    await click(main, '.theme-swatch-light')
    await openCurrentSurface(main)
    await click(main, '.product-language-toggle')
    await until(
      () => main!.webContents.executeJavaScript(`document.documentElement.lang==='en'`),
      'English rail',
    )
    const englishDevice = await main.webContents.executeJavaScript(`(() => {
      const text=document.querySelector('.product-rail [data-view=ink] .product-nav-label');
      return {text:text.textContent,overflow:text.scrollWidth-text.clientWidth};
    })()`)
    assert.equal(englishDevice.text, 'E-paper Device')
    assert.ok(englishDevice.overflow <= 1, JSON.stringify(englishDevice))
    await capture('rail-english-1120')
    await click(main, '.product-language-toggle')
    if (captureAll) {
      // These renderer-only fixtures leave the shared Hub and the default smoke path untouched.
      const savedSnapshot = (await main.webContents.executeJavaScript(
        'window.codepulse.getStatus()',
      )) as StatusSnapshot
      const savedLocale =
        (await main.webContents.executeJavaScript('document.documentElement.lang')) === 'en'
          ? 'en'
          : 'zh'
      const savedCollapsed = (await railState()).collapsed
      const savedSize = main.getContentSize()
      const savedStatusText = await main.webContents.executeJavaScript(
        `document.querySelector('.product-rail-status-text').textContent`,
      )
      const savedInkConnected = inkConnected
      const canonicalBeforeEvidence = JSON.stringify(hub.snapshot().agents)
      const seed = savedSnapshot.agents[0]
      assert.ok(seed, 'capture fixtures start from an existing synthetic agent')
      const evidence: unknown[] = []
      const setEvidenceLocale = async (locale: 'zh' | 'en') => {
        const language = locale === 'zh' ? 'zh-CN' : 'en'
        if (
          (await main!.webContents.executeJavaScript('document.documentElement.lang')) !== language
        )
          await click(main!, '.product-language-toggle')
        await until(
          () =>
            main!.webContents.executeJavaScript(
              `document.documentElement.lang===${JSON.stringify(language)}`,
            ),
          'evidence locale',
        )
      }
      const setEvidenceCollapsed = async (collapsed: boolean) => {
        if ((await railState()).collapsed !== collapsed) await mouseClick('.product-rail-toggle')
        await railWidth(collapsed ? 56 : 200, 'evidence sidebar state')
      }
      const clearEvidenceInteraction = async () => {
        await main!.webContents.executeJavaScript('document.activeElement?.blur()')
        const width = await main!.webContents.executeJavaScript('innerWidth')
        await inspector.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: width - 48,
          y: 120,
        })
      }
      const showEvidenceTasks = async (count: number, text: string) => {
        const now = Date.now()
        const snapshot: StatusSnapshot = {
          ...savedSnapshot,
          updatedAt: now,
          agents: Array.from({ length: count }, (_, index) => ({
            ...seed,
            agentType: 'codex',
            workspacePath: `F:/fixture/rail/task-${index + 1}`,
            externalSessionId: `rail-evidence-${index + 1}`,
            state: TurnState.THINKING,
            lastEventAt: now,
            terminalAt: undefined,
            taskHidden: false,
            unread: false,
            needPermission: false,
            needUserInput: false,
          })),
        }
        main!.webContents.send('codepulse:status', snapshot)
        await until(
          () =>
            main!.webContents.executeJavaScript(
              `document.querySelector('.product-rail-status-text').textContent===${JSON.stringify(text)}`,
            ),
          'evidence task count',
        )
      }
      const captureEvidence = async (name: string, condition: string, state: string) => {
        try {
          await until(() => main!.webContents.executeJavaScript(condition), state)
        } catch (error) {
          const diagnostic = await main!.webContents.executeJavaScript(`(() => {
            const pill=document.querySelector('.product-rail-status'),label=pill.querySelector('.product-rail-status-text'),dot=getComputedStyle(pill.querySelector('.product-rail-status-dot')),style=getComputedStyle(label);
            return {text:label.textContent,classes:pill.className,label:[label.scrollWidth,label.clientWidth,label.scrollHeight,label.clientHeight],pill:[pill.scrollWidth,pill.clientWidth,pill.getBoundingClientRect().height],font:style.fontSize,whiteSpace:style.whiteSpace,dot:dot.backgroundColor,viewport:[innerWidth,innerHeight]};
          })()`)
          writeFileSync(
            join(output, 'rail-evidence-failure.json'),
            JSON.stringify({ name, state, diagnostic }, null, 2),
          )
          throw error
        }
        assert.equal(await main!.webContents.executeJavaScript(condition), true, state)
        const measured = await main!.webContents.executeJavaScript(`(() => {
          const pill=document.querySelector('.product-rail-status'),text=pill.querySelector('.product-rail-status-text');
          return {viewport:[innerWidth,innerHeight],locale:document.documentElement.lang,collapsed:document.querySelector('.product-rail').classList.contains('is-collapsed'),
            status:{text:text.textContent,width:text.clientWidth,scrollWidth:text.scrollWidth,height:pill.getBoundingClientRect().height}};
        })()`)
        await capture(name)
        evidence.push({ file: name + '.png', state, ...measured })
      }
      const connectedMark = (collapsed: boolean) => `(() => {
        const rail=document.querySelector('.product-rail'),mark=rail.querySelector('[data-view=ink] .product-nav-status'),style=getComputedStyle(mark),channels=style.backgroundColor.match(/\\d+/g).map(Number);
        return rail.classList.contains('is-collapsed')===${collapsed} && mark.classList.contains('is-filled') && style.visibility==='visible' && style.opacity==='1' && style.borderTopWidth==='0px' && mark.getBoundingClientRect().width===8 && channels[1]>channels[0] && channels[1]>channels[2];
      })()`
      const statusFits = (text: string, busy: boolean) => `(() => {
        const pill=document.querySelector('.product-rail-status'),label=pill.querySelector('.product-rail-status-text'),style=getComputedStyle(label),box=pill.getBoundingClientRect(),
          dot=getComputedStyle(pill.querySelector('.product-rail-status-dot')),token=getComputedStyle(pill).getPropertyValue(${JSON.stringify(busy ? '--ok' : '--ink-muted')}).trim(),
          actual=dot.backgroundColor.match(/\\d+/g).slice(0,3).map(Number),expected=[1,3,5].map(offset=>parseInt(token.slice(offset,offset+2),16));
        return !document.querySelector('.product-rail').classList.contains('is-collapsed') && pill.classList.contains(${JSON.stringify(busy ? 'is-busy' : 'is-idle')}) && label.textContent===${JSON.stringify(text)} && label.scrollWidth<=label.clientWidth && label.scrollHeight<=label.clientHeight && pill.scrollWidth<=pill.clientWidth && style.fontSize==='12px' && style.whiteSpace==='normal' && style.textOverflow!=='ellipsis' && box.height>=32 && box.bottom<=innerHeight && JSON.stringify(actual)===JSON.stringify(expected) && Array.from(document.querySelectorAll('.product-settings-row button')).every(button=>button.getBoundingClientRect().bottom<=innerHeight);
      })()`
      try {
        await setEvidenceLocale('zh')
        await setEvidenceCollapsed(false)
        await clearEvidenceInteraction()
        inkConnected = true
        publishInk()
        await captureEvidence(
          'rail-evidence-ink-connected-expanded',
          connectedMark(false),
          'connected filled green mark, expanded',
        )
        await setEvidenceCollapsed(true)
        await clearEvidenceInteraction()
        await captureEvidence(
          'rail-evidence-ink-connected-collapsed',
          connectedMark(true),
          'connected filled green mark, collapsed',
        )
        await setEvidenceCollapsed(false)
        await showEvidenceTasks(0, '运行正常 · 空闲')
        await captureEvidence(
          'rail-evidence-status-idle',
          statusFits('运行正常 · 空闲', false),
          'idle status and its full label',
        )
        for (const locale of ['zh', 'en'] as const) {
          await setEvidenceLocale(locale)
          const text = locale === 'zh' ? '运行正常 · 12 个任务执行中' : 'Running · 12 tasks active'
          await showEvidenceTasks(12, text)
          for (const [width, height] of [
            [720, 480],
            [1120, 780],
          ]) {
            main.setContentSize(width!, height!)
            await wait(200)
            await clearEvidenceInteraction()
            await captureEvidence(
              `rail-evidence-status-12-${locale}-${width}`,
              statusFits(text, true),
              `12 ${locale} tasks fit at ${width}px without clipping`,
            )
          }
        }
        const englishRail = (collapsed: boolean) =>
          `document.documentElement.lang==='en' && document.querySelector('.product-rail').classList.contains('is-collapsed')===${collapsed} && document.querySelector('.product-rail [data-view=ink] .product-nav-label').textContent==='E-paper Device'`
        await captureEvidence(
          'rail-evidence-english-expanded',
          englishRail(false),
          'English expanded sidebar',
        )
        await setEvidenceCollapsed(true)
        await clearEvidenceInteraction()
        await captureEvidence(
          'rail-evidence-english-collapsed',
          englishRail(true),
          'English collapsed sidebar',
        )
        await setEvidenceCollapsed(false)
        await clearEvidenceInteraction()
        await main.webContents.executeJavaScript(
          `document.querySelector('.product-rail-toggle').focus()`,
        )
        await pressKey('Tab')
        await captureEvidence(
          'rail-evidence-navigation-tab-focus',
          `(() => {
          const row=document.querySelector('.product-rail [data-view=window]'),style=getComputedStyle(row);
          return document.activeElement===row && row.matches(':focus-visible') && style.outlineStyle==='solid' && style.outlineWidth==='2px';
        })()`,
          'Tab focus has a visible navigation outline',
        )
        await clearEvidenceInteraction()
        await hover('.product-rail [data-view=ink]')
        await captureEvidence(
          'rail-evidence-ink-hover-expanded',
          `(async () => {
          const row=document.querySelector('.product-rail [data-view=ink]'),tip=row.querySelector('.product-tip'),note=(await window.codepulse.getInkStatus()).slotNote.trim();
          return !document.querySelector('.product-rail').classList.contains('is-collapsed') && row.matches(':hover') && getComputedStyle(tip).visibility==='visible' && tip.textContent.startsWith('E-paper Device, connected') && (!note || (!tip.textContent.includes(note) && !row.getAttribute('aria-label').includes(note)));
        })()`,
          'hovering the expanded device row shows its status tooltip',
        )
        await setEvidenceCollapsed(true)
        await clearEvidenceInteraction()
        await hover('.product-rail-status')
        await captureEvidence(
          'rail-evidence-status-hover-collapsed',
          `(() => {
          const pill=document.querySelector('.product-rail-status'),tip=pill.parentElement.querySelector(':scope > .product-tip');
          return document.querySelector('.product-rail').classList.contains('is-collapsed') && pill.matches(':hover') && getComputedStyle(tip).visibility==='visible' && tip.textContent==='Running · 12 tasks active';
        })()`,
          'hovering the collapsed status reveals its full text',
        )
        await hover('.product-language-toggle')
        await captureEvidence(
          'rail-evidence-language-hover-collapsed',
          `(() => {
          const button=document.querySelector('.product-language-toggle'),tip=button.querySelector('.product-tip');
          return document.querySelector('.product-rail').classList.contains('is-collapsed') && button.matches(':hover') && getComputedStyle(tip).visibility==='visible' && tip.textContent.includes('Switch to Chinese');
        })()`,
          'hovering the collapsed language button reveals its action',
        )
      } finally {
        main.webContents.send('codepulse:status', savedSnapshot)
        inkConnected = savedInkConnected
        publishInk()
        await setEvidenceLocale(savedLocale)
        await setEvidenceCollapsed(savedCollapsed)
        main.setContentSize(savedSize[0]!, savedSize[1]!)
        await clearEvidenceInteraction()
        await until(
          () =>
            main!.webContents.executeJavaScript(
              `document.querySelector('.product-rail-status-text').textContent===${JSON.stringify(savedStatusText)}`,
            ),
          'original capture state restored',
        )
        assert.equal(
          JSON.stringify(hub.snapshot().agents),
          canonicalBeforeEvidence,
          'capture fixtures never mutate canonical agents',
        )
      }
      writeFileSync(join(output, 'rail-evidence.json'), JSON.stringify(evidence, null, 2))
    }
    writeFileSync(
      join(output, 'rail-layout.json'),
      JSON.stringify(
        {
          titlebar: shellTop,
          layouts: railLayouts,
          captionChrome: captionLayouts,
          englishDevice,
        },
        null,
        2,
      ),
    )
    await inspector.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false })
    inspector.detach()
    const heartbeatCount = () =>
      main!.webContents.executeJavaScript(
        `Array.from(window.__smokeHeartbeats.values()).filter(delay=>delay===${INK_STATUS_HEARTBEAT_MS}).length`,
      )
    const workbenchReaders = await heartbeatCount()
    assert.equal(workbenchReaders, 2, 'exactly the sidebar and ProductControl read ink status')
    await click(main, '[data-view=settings]')
    const settingsReaders = await heartbeatCount()
    assert.equal(settingsReaders, 1, 'only the sidebar reads ink status on the settings page')
    await click(main, '[data-view=window]')
    const resumedReaders = await heartbeatCount()
    assert.equal(
      resumedReaders,
      2,
      'returning to the workbench restores exactly its reader and the sidebar reader',
    )
    writeFileSync(
      join(output, 'ink-status-readers.json'),
      JSON.stringify({
        workbench: workbenchReaders,
        settings: settingsReaders,
        resumed: resumedReaders,
      }),
    )
    console.log(
      `SMOKE ink status readers: ${workbenchReaders} -> ${settingsReaders} -> ${resumedReaders}`,
    )
    assert.equal(product.snapshot().desktopLayout, 'work')
    assert.ok(
      await main.webContents.executeJavaScript(
        `Boolean(document.querySelector('.product-console-live-stage'))`,
      ),
    )
    await click(main, '[data-view=usage]')
    assert.ok(
      await main.webContents.executeJavaScript(
        `document.body.textContent.includes('暂无可用的历史统计')`,
      ),
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelectorAll('.product-targets').length`,
      ),
      0,
    )
    const beforeStatusClick = product.snapshot()
    const statusDisplay = await main.webContents.executeJavaScript(`(() => {
      const mark=document.querySelector('.product-rail [data-view=ink] .product-nav-status');
      return {hidden:mark.getAttribute('aria-hidden'), role:mark.getAttribute('role'), focusable:mark.hasAttribute('tabindex'),
        controls:mark.querySelectorAll('button,a,input,[role=button],[tabindex]').length};
    })()`)
    assert.deepEqual(statusDisplay, { hidden: 'true', role: null, focusable: false, controls: 0 })
    await click(main, '.product-rail [data-view=ink] .product-nav-status')
    // The mark is part of its row, so a click does what the row does and nothing of its own.
    assert.equal(product.snapshot().view, 'ink', 'status click only follows its row')
    assert.deepEqual(
      product.snapshot().inkPlan,
      beforeStatusClick.inkPlan,
      'status click never edits the playlist',
    )
    assert.equal(
      product.snapshot().hudVisible,
      beforeStatusClick.hudVisible,
      'status click never opens the overlay',
    )
    await openCurrentSurface(main)
    await click(main, '[data-view=ink]')
    await until(
      () =>
        main!.webContents.executeJavaScript(
          `document.querySelector('.product-control .device-preview')?.getAttribute('data-render-state')==='ready'`,
        ),
      'ink draft preview',
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelectorAll('.product-tabs-label,.ink-empty-card,.ink-preview-card .device-preview-footnote').length`,
      ),
      0,
      'control removes static explanatory chrome',
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelectorAll('.ink-config .product-config-actions').length`,
      ),
      0,
      'synced playlist has no apply area',
    )
    const beforePlayback = structuredClone(product.snapshot().inkPlan)
    await selectPlayback('fixed')
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelector('.product-config-actions strong').textContent`,
      ),
      '1 项未应用',
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.ink-config [role=switch]')).every(b=>b.disabled)`,
      ),
      true,
    )
    await button(main, '应用')
    assert.equal(product.snapshot().inkPlan.mode, 'single')
    assert.equal(product.snapshot().inkPlan.fixed, 'work')
    assert.deepEqual(product.snapshot().inkPlan.items, beforePlayback.items)
    assert.equal(product.snapshot().inkPlan.intervalMinutes, beforePlayback.intervalMinutes)
    await selectPlayback('5')
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelector('.product-config-actions strong').textContent`,
      ),
      '1 项未应用',
      'combined mode/dwell count once',
    )
    await selectPlayback('15')
    await button(main, '应用')
    await click(main, 'button[role=switch][aria-label="待办与提醒加入节目单"]')
    assert.equal(product.snapshot().view, 'ink', 'playlist switches never navigate')
    assert.deepEqual(
      product.snapshot().inkPlan.items,
      beforePlayback.items,
      'membership stays a draft',
    )
    await click(main, 'button[role=switch][aria-label="待办与提醒加入节目单"]')
    await click(main, '.ink-row-main[aria-label="桌边内容"]')
    await until(
      () => product.snapshot().view === 'plugins',
      'legacy desk-content entry settles on plugins',
    )
    await openCurrentSurface(main)
    await click(main, '[data-view=ink]')
    await click(main, '.ink-row-main[aria-label="待办与提醒"]')
    await until(
      () => product.snapshot().view === 'plugins',
      'legacy todo/reminders entry settles on plugins',
    )
    await openCurrentSurface(main)
    await click(main, '[data-view=ink]')
    inkConnected = false
    publishInk()
    await wait()
    assert.equal(
      await main.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.product-control button')).filter(b=>b.getClientRects().length&&b.textContent.trim()==='连接设备').length`,
      ),
      1,
      'one connect owner in the preview header',
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelector('.device-preview-tag').textContent`,
      ),
      '预览',
    )
    await button(main, '连接设备')
    assert.ok(
      await main.webContents.executeJavaScript(
        `Boolean(document.querySelector('#ink-provisioning'))`,
      ),
      'connect reveals the existing provisioning panel',
    )
    const connectedLayout = await main.webContents.executeJavaScript(`(() => {
      const preview=document.querySelector('.ink-preview-card').getBoundingClientRect(),playlist=document.querySelector('.ink-config').getBoundingClientRect(),
        connection=document.querySelector('#ink-provisioning').getBoundingClientRect();
      return {viewport:[innerWidth,innerHeight],top:Math.abs(preview.top-playlist.top),bottom:Math.abs(preview.bottom-playlist.bottom),connectionBelow:connection.top>=preview.bottom};
    })()`)
    assert.deepEqual(connectedLayout.viewport, [1120, 780])
    assert.ok(
      connectedLayout.top <= 1 && connectedLayout.bottom <= 1,
      JSON.stringify(connectedLayout),
    )
    assert.ok(
      connectedLayout.connectionBelow,
      'connection details occupy their own row below the preview',
    )
    await button(main, '收起')
    assert.equal(
      await main.webContents.executeJavaScript(
        `Boolean(document.querySelector('#ink-provisioning'))`,
      ),
      false,
    )
    await selectPlayback('5')
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelector('.product-config-actions strong').textContent`,
      ),
      '1 项改动，连接后自动应用',
    )
    await until(
      () => product.snapshot().inkPlan.intervalMinutes === 5,
      'offline changes auto-apply',
    )
    await wait(900)
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelector('.product-config-actions strong')?.textContent`,
      ),
      '1 项改动，连接后自动应用',
      'applied offline changes stay counted until the device connects',
    )
    await selectPlayback('15')
    await until(() => product.snapshot().inkPlan.intervalMinutes === 15, 'offline change reverts')
    await until(
      () =>
        main!.webContents.executeJavaScript(
          `document.querySelectorAll('.ink-config .product-config-actions').length===0`,
        ),
      'back at the baseline hides the notice',
    )
    await selectPlayback('5')
    await until(
      () => product.snapshot().inkPlan.intervalMinutes === 5,
      'offline change applies again',
    )
    await wait(900)
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelector('.product-config-actions strong')?.textContent`,
      ),
      '1 项改动，连接后自动应用',
    )
    // Disabled reasons are keyboard-reachable explanations (InfoTip) and stay inside a narrow window.
    main.setContentSize(720, 600)
    await wait(350)
    await click(main, '[data-view=plugins]')
    await click(main, '#plugins-market-tab')
    await until(
      () =>
        main!.webContents.executeJavaScript(
          `Boolean(document.querySelector('.plugin-store .page-header p'))`,
        ),
      'offline store reason',
    )
    const storeReason = await main.webContents.executeJavaScript(`(() => {
      const reason=document.querySelector('.plugin-store .page-header p'),style=getComputedStyle(reason);
      return {font:style.fontSize,color:style.color,muted:style.getPropertyValue('--ink-muted').trim()};
    })()`)
    assert.equal(storeReason.font, '13px')
    assert.equal(storeReason.color, rgb(storeReason.muted))
    await capture('plugin-store-offline')
    await openInstalledPlugins(main, 'local:todo')
    if (platform === 'win32') {
      const detail = await main.webContents.executeJavaScript(`(() => {
        const layer=document.querySelector('.plugin-details-layer:not([hidden])'),close=layer.querySelector('.plugin-details-close button');
        return {top:layer.getBoundingClientRect().top,closeTop:close.getBoundingClientRect().top,bottom:layer.getBoundingClientRect().bottom,height:innerHeight};
      })()`)
      assert.ok(
        detail.top >= shellTop.band!.height && detail.closeTop >= shellTop.band!.height,
        'the plugin close button clears the caption strip: ' + JSON.stringify(detail),
      )
      assert.ok(detail.bottom <= detail.height, 'the drawer stays inside the remaining viewport')
      await capture('plugin-details-caption-clearance')
    }
    const tip = (await main.webContents.executeJavaScript(
      `(()=>{const b=document.querySelector('.desk-assistant .info-tip');return b?{id:b.getAttribute('aria-describedby'),text:document.getElementById(b.getAttribute('aria-describedby')).textContent,h:b.getBoundingClientRect().height,w:b.getBoundingClientRect().width,tab:b.tabIndex}:null})()`,
    )) as { id: string; text: string; h: number; w: number; tab: number } | null
    assert.ok(
      tip && tip.text === '连接设备后可临时展示' && tip.h >= 32 && tip.w >= 32 && tip.tab >= 0,
      'the disabled reason is a focusable 32px InfoTip: ' + JSON.stringify(tip),
    )
    // The todo detail sits below the fold at 600px; a pointer can only hover the tip once it is scrolled into view.
    await main.webContents.executeJavaScript(
      `(()=>{const b=document.querySelector('.desk-assistant .info-tip');b.scrollIntoView({block:'center'});b.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))})()`,
    )
    await wait(120)
    const bubble = (await main.webContents.executeJavaScript(
      `(()=>{const t=document.querySelector('.desk-assistant .info-tip-bubble'),r=t.getBoundingClientRect();return {open:t.classList.contains('is-open'),left:r.left,right:r.right,top:r.top,bottom:r.bottom,w:innerWidth,h:innerHeight}})()`,
    )) as {
      open: boolean
      left: number
      right: number
      top: number
      bottom: number
      w: number
      h: number
    }
    assert.ok(
      bubble.open &&
        bubble.left >= 0 &&
        bubble.right <= bubble.w &&
        bubble.top >= 0 &&
        bubble.bottom <= bubble.h,
      'the bubble opens inside the 720px window: ' + JSON.stringify(bubble),
    )
    await capture('infotip-720')
    await main.webContents.executeJavaScript(
      `document.querySelector('.desk-assistant .info-tip').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
    )
    await wait(120)
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelector('.desk-assistant .info-tip-bubble').classList.contains('is-open')`,
      ),
      false,
      'Escape closes the bubble',
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelector('.plugin-details-layer:has(.desk-assistant)')?.hidden`,
      ),
      false,
      'the first Escape closes only the bubble, not the plugin details around it',
    )
    main.setContentSize(1120, 780)
    await wait(350)
    await openCurrentSurface(main)
    await click(main, '[data-view=ink]')
    inkConnected = true
    publishInk()
    await wait()
    await selectPlayback('15')
    await button(main, '应用')
    await selectPlayback('5') // A real pending change keeps the footer present for the layout checks.
    const previewWidth = await main.webContents.executeJavaScript(
      `document.querySelector('.product-control .device-preview canvas').getBoundingClientRect().width`,
    )
    assert.ok(previewWidth > 0, 'preview is shown at default window size')
    const layouts: unknown[] = []
    const geometry = () =>
      main!.webContents.executeJavaScript(`(() => {
      const control = document.querySelector('.product-control');
      const stage = document.querySelector('.ink-control-workspace .product-preview-stage');
      const canvas = stage.querySelector('.device-preview-scroll canvas').getBoundingClientRect();
      const preview=stage.getBoundingClientRect(),playlist=document.querySelector('.ink-config').getBoundingClientRect();
      const apply = document.querySelector('.ink-config .product-config-actions')?.getBoundingClientRect() ?? {top:0,bottom:0};
      const titleCenter=(selector)=>{const range=document.createRange();range.selectNodeContents(document.querySelector(selector));const box=range.getBoundingClientRect();return box.top+box.height/2};
      return {viewport: [innerWidth,innerHeight], dpr: devicePixelRatio, canvas: [canvas.width,canvas.height], origin: [canvas.left,canvas.top],
        cards:{preview:[preview.top,preview.bottom],playlist:[playlist.top,playlist.bottom]},
        titleCenters:[titleCenter('.ink-preview-card .device-preview-header h2'),titleCenter('.ink-config .product-config-heading h2')],
        moreButtonHeight:stage.querySelector('.device-preview-more').getBoundingClientRect().height,
        canvasBottom: canvas.bottom, applyBottom: apply.bottom, applyTop: apply.top,
        pageOverflow: control.scrollHeight-control.clientHeight,
        previewOverflow: stage.scrollHeight-stage.clientHeight,
        configOverflow: document.querySelector('.ink-config').scrollHeight-document.querySelector('.ink-config').clientHeight,
        horizontalOverflow: document.documentElement.scrollWidth-innerWidth};
    })()`)
    for (const [width, height] of [
      [1120, 780],
      [1366, 900],
      [1440, 900],
      [1600, 1000],
      [1000, 720],
    ]) {
      main.setContentSize(width!, height!)
      await wait(250)
      const measured = await geometry()
      layouts.push(measured)
      assertWholePixels(
        measured.canvas as number[],
        measured.dpr as number,
        1,
        'resizing keeps whole physical pixels per device pixel',
        measured.origin as number[],
      )
      if (width === 1440)
        assert.equal(
          pixelRatio(measured.canvas as number[], measured.dpr as number),
          Math.max(1, Math.round(measured.dpr as number)),
          '1440x900 reaches the preferred 1:k scale',
        )
      assert.ok(measured.previewOverflow <= 1, JSON.stringify(measured))
      if (width! >= 1120) assert.ok(measured.configOverflow <= 1, JSON.stringify(measured))
      assert.equal(
        await main.webContents.executeJavaScript(
          `getComputedStyle(document.querySelector('.ink-config .product-config-actions')).position`,
        ),
        'static',
        'apply stays in document flow',
      )
      await main.webContents.executeJavaScript(
        `document.querySelector('.ink-config .product-config-actions').scrollIntoView({block:'end'})`,
      )
      assert.ok(
        await main.webContents.executeJavaScript(
          `document.querySelector('.ink-config .product-config-actions').getBoundingClientRect().bottom<=innerHeight+1`,
        ),
        'apply footer is reachable by scrolling',
      )
      await main.webContents.executeJavaScript(
        `document.querySelector('.product-control').scrollTop=0`,
      )
      assert.equal(measured.horizontalOverflow, 0)
      if (width! >= 1120) {
        assert.ok(
          Math.abs(measured.cards.preview[0] - measured.cards.playlist[0]) <= 1 &&
            Math.abs(measured.cards.preview[1] - measured.cards.playlist[1]) <= 1,
          `side-by-side cards share their top and bottom: ${JSON.stringify(measured)}`,
        )
      }
      if (width === 1120) {
        assert.ok(
          Math.abs(measured.titleCenters[0] - measured.titleCenters[1]) <= 1,
          `ink card title text shares its vertical center: ${JSON.stringify(measured)}`,
        )
        assert.ok(measured.moreButtonHeight >= 36, 'the preview menu button keeps its hit area')
      }
      if (width === 1120 && captureAll) {
        await until(
          () =>
            main!.webContents.executeJavaScript(`(() => {
            const preview=document.querySelector('.ink-preview-card'),playlist=document.querySelector('.ink-config'),a=preview.getBoundingClientRect(),b=playlist.getBoundingClientRect();
            return innerWidth===1120 && innerHeight===780 && document.documentElement.dataset.theme==='light' && preview.querySelector('.device-preview').dataset.renderState==='ready' && Math.abs(a.top-b.top)<=1 && Math.abs(a.bottom-b.bottom)<=1;
          })()`),
          'light 1120px ink cards are ready and equally tall before capture',
        )
        await capture('ink-equal-height-light-1120', true)
      }
      await capture('ink-' + width + 'x' + height)
    }
    main.setContentSize(1120, 780)
    await wait(250)
    {
      // The menu is an overlay. Exercise a genuine height constraint independently of menu state.
      const scale = async () => {
        const m = await geometry()
        return { k: pixelRatio(m.canvas as number[], m.dpr as number), m }
      }
      const originalZoom = main.webContents.getZoomFactor()
      const originalDpr = (await main.webContents.executeJavaScript('devicePixelRatio')) as number
      const stageStyle = (await main.webContents.executeJavaScript(
        `document.querySelector('.ink-preview-card').style.cssText`,
      )) as string
      try {
        main.setContentSize(1600, 1000)
        main.webContents.setZoomFactor((originalZoom * 2) / originalDpr)
        await wait(350)
        const natural = await scale(),
          preferred = Math.round(natural.m.dpr as number)
        assert.ok(preferred >= 2, 'fixture has at least two integer scales')
        assert.equal(natural.k, preferred, 'unconstrained stage reaches preferred integer scale')
        const heights = (await main.webContents.executeJavaScript(`(() => {
          const stage=document.querySelector('.ink-preview-card');
          const full=stage.getBoundingClientRect().height,short=full-150/devicePixelRatio;
          stage.style.boxSizing='border-box';stage.style.height=short+'px';stage.style.overflow='hidden';
          return {full,short};
        })()`)) as { full: number; short: number }
        await until(
          async () => (await scale()).k < preferred,
          'real height constraint caps the preview',
        )
        const before = await scale()
        await main.webContents.executeJavaScript(
          `document.querySelector('.ink-preview-card').style.height=${JSON.stringify(heights.full + 'px')}`,
        )
        await until(
          async () => (await scale()).k === preferred,
          'restoring real room lifts the cap',
        )
        const roomy = await scale()
        assert.ok(roomy.k > before.k, 'cap recovery must actually increase the scale')
        await main.webContents.executeJavaScript(
          `document.querySelector('.ink-preview-card').style.height=${JSON.stringify(heights.short + 'px')}`,
        )
        await until(
          async () => (await scale()).k === before.k,
          'restricting real room restores the cap',
        )
        const back = await scale()
        for (const measured of [before.m, roomy.m, back.m]) {
          assert.ok(measured.previewOverflow <= 1, JSON.stringify(measured))
          assertWholePixels(
            measured.canvas as number[],
            measured.dpr as number,
            1,
            'height cap preserves integer pixels',
            measured.origin as number[],
          )
        }
        writeFileSync(
          join(output, 'cap-lift.json'),
          JSON.stringify({ natural, before, roomy, back, preferred, heights }, null, 2),
        )
      } finally {
        await main.webContents.executeJavaScript(
          `document.querySelector('.ink-preview-card').style.cssText=${JSON.stringify(stageStyle)}`,
        )
        main.webContents.setZoomFactor(originalZoom)
        main.setContentSize(1120, 780)
        await wait(350)
      }
    }
    for (const zoom of [1.25, 1.5, 2, 1]) {
      main.webContents.setZoomFactor(zoom)
      await wait(300)
      const measured = await geometry()
      layouts.push(measured)
      assertWholePixels(
        measured.canvas as number[],
        measured.dpr as number,
        1,
        `zoom ${zoom} keeps whole physical pixels`,
        measured.origin as number[],
      )
      assert.equal(measured.horizontalOverflow, 0, JSON.stringify(measured))
      assert.ok(measured.previewOverflow <= 1, JSON.stringify(measured))
      // Below 900 CSS px the control page stacks and scrolls as a whole, by design.
      assert.equal(
        measured.configOverflow,
        0,
        'the playlist does not clip content behind a sticky footer',
      )
    }
    await wait(250)
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelector('.device-preview-more').getAttribute('aria-expanded')`,
      ),
      'false',
      'preview menu starts closed',
    )
    const beforeMenu = await geometry()
    await button(main, '⋯')
    const withMenu = await geometry()
    assert.deepEqual(
      withMenu.canvas,
      beforeMenu.canvas,
      'opening the portal menu cannot change integer scale',
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelector('.device-preview-menu')?.getAttribute('role')`,
      ),
      'dialog',
    )
    main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    await until(
      () => main!.webContents.executeJavaScript(`!document.querySelector('.device-preview-menu')`),
      'Escape closes the preview menu',
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.activeElement?.getAttribute('aria-label')`,
      ),
      '预览选项',
      'menu Escape restores its trigger focus',
    )
    assert.deepEqual(
      (await geometry()).canvas,
      beforeMenu.canvas,
      'closing the portal menu cannot change integer scale',
    )
    {
      // Place the same trigger near the small window's bottom to exercise measured upward placement.
      const originalStyle = (await main.webContents.executeJavaScript(
        `document.querySelector('.device-preview-more').style.cssText`,
      )) as string
      try {
        main.setContentSize(720, 480)
        await wait(350)
        await main.webContents.executeJavaScript(
          `Object.assign(document.querySelector('.device-preview-more').style,{position:'fixed',right:'16px',bottom:'16px',top:'auto',zIndex:'101'})`,
        )
        await button(main, '⋯')
        const box = (await main.webContents.executeJavaScript(`(() => {
          const m=document.querySelector('.device-preview-menu').getBoundingClientRect(),a=document.querySelector('.device-preview-more').getBoundingClientRect();
          return {top:m.top,bottom:m.bottom,left:m.left,right:m.right,gap:a.top-m.bottom,width:innerWidth,height:innerHeight};
        })()`)) as {
          top: number
          bottom: number
          left: number
          right: number
          gap: number
          width: number
          height: number
        }
        assert.ok(
          box.top >= 15 &&
            box.bottom <= box.height - 15 &&
            box.left >= 15 &&
            box.right <= box.width - 15,
          'small-window menu stays inside the viewport: ' + JSON.stringify(box),
        )
        assert.ok(
          Math.abs(box.gap - 8) <= 1,
          'upward menu uses its measured height and an 8px gap: ' + JSON.stringify(box),
        )
        writeFileSync(join(output, 'preview-menu-small.json'), JSON.stringify(box, null, 2))
      } finally {
        main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
        await wait()
        await main.webContents.executeJavaScript(
          `document.querySelector('.device-preview-more').style.cssText=${JSON.stringify(originalStyle)}`,
        )
        main.setContentSize(1120, 780)
        await wait(350)
      }
    }
    await button(main, '⋯')
    const beforeInspect = JSON.stringify(config)
    await button(main, '2×')
    assert.ok(
      await main.webContents.executeJavaScript(
        `Boolean(document.querySelector('.ink-control-workspace dialog[open]'))`,
      ),
    )
    const inspectSize = await main.webContents.executeJavaScript(
      `(() => { const r=document.querySelector('dialog[open] canvas').getBoundingClientRect(); return [r.width,r.height] })()`,
    )
    assertWholePixels(
      inspectSize,
      await main.webContents.executeJavaScript('devicePixelRatio'),
      2,
      'inspection uses a deliberate whole-pixel zoom of at least 2x',
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelector('.ink-control-workspace .device-preview-scroll canvas').toDataURL() === document.querySelector('dialog[open] canvas').toDataURL()`,
      ),
      true,
      'both views use identical source pixels',
    )
    await capture('ink-inspector')
    await button(main, '关闭检查')
    assert.equal(
      await main.webContents.executeJavaScript(`document.querySelectorAll('dialog[open]').length`),
      0,
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.activeElement?.getAttribute('aria-label')`,
      ),
      '预览选项',
      'inspection restores the menu trigger focus',
    )
    assert.equal(JSON.stringify(config), beforeInspect, 'inspection never applies device settings')
    await click(main, '.ink-work-options summary')
    const normalPixels = await main.webContents.executeJavaScript(
      `Array.from(document.querySelector('.ink-control-workspace .device-preview-scroll canvas').getContext('2d').getImageData(0,0,400,300).data)`,
    )
    await main.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.ink-config label')).find(l=>l.textContent.includes('反色显示')).querySelector('input').click()`,
    )
    assert.equal(config.inverted, false, 'connected changes stay drafts')
    assert.deepEqual(
      await main.webContents.executeJavaScript(
        `Array.from(document.querySelector('.ink-control-workspace .device-preview-scroll canvas').getContext('2d').getImageData(0,0,400,300).data)`,
      ),
      normalPixels,
      'live preview keeps the applied target',
    )
    await button(main, '应用')
    await until(
      () =>
        main!.webContents.executeJavaScript(
          `document.querySelector('.ink-control-workspace .device-preview-scroll canvas').getContext('2d').getImageData(0,0,1,1).data[0]===0`,
        ),
      'applied inverted pixels',
    )
    const invertedPixels = await main.webContents.executeJavaScript(
      `Array.from(document.querySelector('.ink-control-workspace .device-preview-scroll canvas').getContext('2d').getImageData(0,0,400,300).data)`,
    )
    assert.deepEqual(
      invertedPixels,
      normalPixels.map((v: number, i: number) => (i % 4 === 3 ? v : 255 - v)),
      'apply updates the production pixels',
    )
    await capture('ink-inverted')
    await main.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.ink-config label')).find(l=>l.textContent.includes('反色显示')).querySelector('input').click()`,
    )
    await button(main, '应用')
    const beforeSamples = JSON.stringify(config)
    await button(main, '⋯')
    await button(main, '9 任务')
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelector('.device-preview-tag').textContent`,
      ),
      '样例',
    )
    assert.equal(
      JSON.stringify(config),
      beforeSamples,
      'sample selection never applies synthetic content',
    )
    await capture('ink-dense')
    await button(main, '2×')
    await capture('ink-dense-inspector')
    main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    await until(
      () =>
        main!.webContents.executeJavaScript(`document.querySelectorAll('dialog[open]').length===0`),
      'Escape closes the inspection',
    )
    await button(main, '⋯')
    await button(main, '实时')
    main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    await wait()
    writeFileSync(join(output, 'layout.json'), JSON.stringify(layouts, null, 2))
    await capture('control-ink')
    // The work-screen content choice lives in the collapsed 「画面细项」 section.
    await main.webContents.executeJavaScript(
      `document.querySelector('.ink-work-options').open = true`,
    )
    await wait()
    await button(main, '开销看板')
    assert.equal(config.mode, 'hud')
    const draftPlan = structuredClone(product.snapshot().inkPlan)
    await click(main, '[data-view=settings]')
    await click(main, '[data-view=ink]')
    assert.equal(product.snapshot().target, 'ink')
    assert.equal(config.mode, 'hud', 'ordinary navigation never applies the retained draft')
    assert.deepEqual(product.snapshot().inkPlan, draftPlan)
    assert.ok(
      await main.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.product-control .ink-config button')).some(b=>b.textContent==='开销看板' && b.getAttribute('aria-pressed')==='true')`,
      ),
    )
    await button(main, '应用')
    assert.equal(config.mode, 'usage')
    await click(main, '[data-view=overlay]')
    await until(
      () =>
        main!.webContents.executeJavaScript(
          `Boolean(document.querySelector('.product-control .hud-preview .project-deck-shell'))`,
        ),
      'real HUD preview',
    )
    await capture('control-hud')
    for (const [label, style] of [
      ['灵动岛', 'island'],
      ['胶囊流', 'pills'],
      ['边缘抽屉', 'edge'],
      ['悬浮球', 'orb'],
    ] as const) {
      await button(main, label)
      assert.equal(product.snapshot().hudSettings.hudStyle, style)
      await until(
        () =>
          main!.webContents.executeJavaScript(
            `Boolean(document.querySelector('.product-control .hud-compact-preview .hud-c[data-c-style=${style}]'))`,
          ),
        `${style} preview`,
      )
      for (const [width, height] of [
        [1120, 780],
        [720, 480],
      ] as const) {
        main.setContentSize(width, height)
        await capture(`control-hud-${style}-${width}`)
        assert.equal(
          await main.webContents.executeJavaScript(
            `document.querySelector('.hud-preview-stage').scrollWidth>document.querySelector('.hud-preview-stage').clientWidth`,
          ),
          false,
          `${style} preview fits at ${width}`,
        )
      }
      main.setContentSize(1120, 780)
    }
    await button(main, '面板')
    assert.equal(product.snapshot().hudSettings.hudStyle, 'panel')
    // Only the visible preview consumes status updates. Keep the UI responsive while saving is slow.
    await wait(400)
    const inactiveReads = readCount('get-device-display'),
      ambientReads = readCount('ambient-get')
    for (let i = 0; i < 40; i++) broadcast('codepulse:status', hub.snapshot())
    await wait(400)
    assert.equal(
      readCount('get-device-display'),
      inactiveReads,
      'hidden ink never reads on agent events',
    )
    assert.equal(readCount('ambient-get'), ambientReads, 'agent events do not read content')
    targetDelay = 650
    await main.webContents.executeJavaScript("document.querySelector('[data-view=ink]').click()")
    await wait(100)
    assert.equal(product.snapshot().target, 'hud', 'fixture save is still pending')
    assert.equal(
      await main.webContents.executeJavaScript(
        "document.querySelector('[data-view=ink]').getAttribute('aria-current')",
      ),
      null,
      'surface route waits for persistence',
    )
    await until(() => product.snapshot().target === 'ink', 'delayed target saved')
    await wait(300)
    targetDelay = 0
    await main.webContents.executeJavaScript(`(() => {
      const preview = document.querySelector('.ink-control-workspace .device-preview');
      window.__previewStates = [preview.getAttribute('data-render-state')];
      window.__previewObserver = new MutationObserver(() => window.__previewStates.push(preview.getAttribute('data-render-state')));
      window.__previewObserver.observe(preview, {attributes:true,attributeFilter:['data-render-state']});
    })()`)
    const activeReads = readCount('get-device-display'),
      contentReads = readCount('ambient-get')
    for (let i = 0; i < 40; i++) broadcast('codepulse:status', hub.snapshot())
    await wait(400)
    assert.equal(
      readCount('get-device-display') - activeReads,
      1,
      'burst of agent updates coalesces to one preview read',
    )
    assert.equal(readCount('ambient-get'), contentReads, 'work refresh does not reload X/meme')
    assert.ok(
      await main.webContents.executeJavaScript(
        `window.__previewObserver.disconnect(); window.__previewStates.every(state=>state==='ready')`,
      ),
      'background frames remain ready without flashing loading states',
    )
    targetDelay = 500
    await main.webContents.executeJavaScript(
      "document.querySelector('[data-view=overlay]').click()",
    )
    await wait(30)
    await main.webContents.executeJavaScript("document.querySelector('[data-view=window]').click()")
    await wait(30)
    await main.webContents.executeJavaScript("document.querySelector('[data-view=ink]').click()")
    await wait(100)
    assert.equal(
      await main.webContents.executeJavaScript(
        "document.querySelector('[data-view=ink]').getAttribute('aria-current')",
      ),
      'page',
      'the confirmed surface stays selected until persistence',
    )
    await wait(650)
    assert.equal(product.snapshot().target, 'ink')
    targetDelay = 0
    failTarget = 'hud'
    await click(main, '[data-view=overlay]')
    await until(
      () =>
        main!.webContents.executeJavaScript(
          "Boolean(document.querySelector('.product-attention[role=alert]'))",
        ),
      'failed-save feedback',
    )
    assert.equal(product.snapshot().target, 'ink')
    assert.equal(
      await main.webContents.executeJavaScript(
        "document.querySelector('[data-view=ink]').getAttribute('aria-current')",
      ),
      'page',
      'failed save rolls back selection',
    )
    failTarget = undefined
    await click(main, '[data-view=overlay]')
    writeFileSync(
      join(output, 'switching.json'),
      JSON.stringify(
        {
          immediateSelection: true,
          rapidSelection: true,
          rollback: true,
          hiddenPreviewPaused: true,
          coalescedReads: true,
          previewReads,
        },
        null,
        2,
      ),
    )

    assert.equal(product.snapshot().hudVisible, false, 'target selection must not open a window')
    await button(main, '开启悬浮窗')
    await until(
      () => BrowserWindow.getAllWindows().some((w) => w.getTitle() === 'CodePulse HUD'),
      'HUD window',
    )
    const hudWindow = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'CodePulse HUD')!
    await until(
      () =>
        hudWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.surface-controls.is-compact'))`,
        ),
      'HUD controls',
    )
    assert.equal(visible.get(main.id), true, 'desktop and HUD coexist')
    assert.equal(product.snapshot().hudVisible, true)
    assert.ok(hudWindow.isVisible(), 'open must actually show the native window')
    // Simulate a stale off-screen/minimized HUD, then explicitly reopen from Control.
    hudWindow.setBounds({ x: 50000, y: 50000, width: 470, height: 300 })
    let minimized = true,
      restored = false,
      focused = false
    const originalMinimized = hudWindow.isMinimized.bind(hudWindow),
      originalRestore = hudWindow.restore.bind(hudWindow),
      originalFocus = hudWindow.focus.bind(hudWindow)
    hudWindow.isMinimized = () => minimized
    hudWindow.restore = () => {
      minimized = false
      restored = true
    }
    hudWindow.focus = () => {
      focused = true
    }
    assert.equal(hud.isVisible(), false, 'minimized window is not reported as visible')
    product.setHudVisible(true)
    assert.equal(restored, true, 'explicit open restores minimized HUD')
    assert.equal(focused, true, 'explicit open brings HUD forward')
    assert.equal(hud.isVisible(), true)
    const area = screenApi.getDisplayMatching(main.getBounds()).workArea,
      bounds = hudWindow.getBounds()
    assert.ok(
      bounds.x >= area.x &&
        bounds.y >= area.y &&
        bounds.x + bounds.width <= area.x + area.width &&
        bounds.y + bounds.height <= area.y + area.height,
      'reopen recovers off-screen bounds onto client display',
    )
    hudWindow.isMinimized = originalMinimized
    hudWindow.restore = originalRestore
    hudWindow.focus = originalFocus
    writeFileSync(
      join(output, 'hud-reveal.json'),
      JSON.stringify({ restored, focused, area, bounds, visible: hud.isVisible() }, null, 2),
    )
    assert.equal(product.snapshot().form, 'standard', 'opening HUD preserves launch preference')
    const clientLayout = product.snapshot().desktopLayout
    main.hide()
    await button(hudWindow, '标准')
    assert.equal(visible.get(main.id), true, 'the HUD standard action reveals the client')
    assert.equal(product.snapshot().form, 'standard')
    assert.equal(product.snapshot().desktopLayout, clientLayout)
    assert.equal(
      product.snapshot().view,
      product.snapshot().target === 'hud'
        ? 'overlay'
        : product.snapshot().target === 'ink'
          ? 'ink'
          : 'window',
    )
    assert.equal(visible.get(hudWindow.id), true, 'HUD return opens console without hiding HUD')
    if (captureAll)
      writeFileSync(join(output, 'hud.png'), (await hudWindow.webContents.capturePage()).toPNG())
    // Updates keeps the original bounded service; synthetic content never touches live accounts.
    await openInstalledPlugins(main)
    assert.equal(product.snapshot().target, 'ink')
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelectorAll('.product-targets').length`,
      ),
      0,
    )
    // 桌边内容: one category list whose rows carry the *Enabled rules; rules save by themselves.
    const TEMP = '临时展示 10 分钟'
    const category = (id: string) => openInstalledPlugins(main!, `local:${id}`)
    const openSettings = async () => {
      if (
        !(await main!.webContents.executeJavaScript(
          `Boolean(document.querySelector('.ambient-settings')?.open)`,
        ))
      )
        await click(main!, '.ambient-settings > summary')
    }
    // The primary button is disabled until a card is selected and the screen is online.
    const showTemp = async () => {
      await until(
        () =>
          main!.webContents.executeJavaScript(
            `(()=>{const b=document.querySelector('.plugin-ink-preview .plugin-preview-actions .primary');return Boolean(b&&!b.disabled&&document.querySelector('.ambient-item[aria-pressed=true]'))})()`,
          ),
        'temporary display is available',
      )
      await button(main, TEMP)
    }
    const previewReady = () =>
      until(
        () =>
          main!.webContents.executeJavaScript(
            `document.querySelector('.ambient-panel .device-preview')?.getAttribute('data-render-state')==='ready'`,
          ),
        'ambient preview renderer',
      )
    assert.deepEqual(
      await main.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.plugin-row[data-plugin-id^="local:"]:not([data-plugin-id="local:todo"]) .plugin-who strong')).map(s=>s.textContent)`,
      ),
      [
        '概念卡',
        '思考实验',
        '像素宠物',
        '日历',
        '科技热议',
        'X 与 meme',
        '我的图片与便签',
        '生活卡',
        '工具更新',
        '假日公告',
        '今日要闻',
      ],
      'category order',
    )
    // 元宝搜索 rows: inert without a saved key and say why, samples tagged 示例, key fields never keep a key.
    const setField = (selector: string, value: string) =>
      main!.webContents.executeJavaScript(
        `(()=>{const f=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(f,${JSON.stringify(value)});f.dispatchEvent(new Event('input',{bubbles:true}))})()`,
      )
    const yuanbaoBefore = JSON.stringify(ambient.snapshot().config)
    for (const id of ['life', 'tools', 'holiday', 'headlines']) {
      assert.deepEqual(
        await main.webContents.executeJavaScript(
          `(()=>{const r=document.querySelector('.plugin-row[data-plugin-id="local:${id}"]');return [r.querySelector('.plugin-state-label').textContent,r.querySelector('.plugin-state p')?.textContent??'',r.querySelector('.plugin-switch').disabled]})()`,
        ),
        ['需要设置', '请先填写元宝搜索密钥', true],
        id + ' switch is inert without a key and the row says why',
      )
      await click(main, `.plugin-row[data-plugin-id="local:${id}"] .plugin-switch`)
    }
    await wait(700)
    assert.equal(
      JSON.stringify(ambient.snapshot().config),
      yuanbaoBefore,
      'inert switches change nothing',
    )
    await category('life')
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelectorAll('.ambient-items [data-sample]').length`,
      ),
      3,
      'life offers weather, gold and stock samples while it has no card',
    )
    if (
      await main.webContents.executeJavaScript(
        `typeof window.codepulse.previewYuanbaoSample==='function'`,
      )
    ) {
      await until(
        () =>
          main!.webContents.executeJavaScript(
            `document.querySelector('.ambient-panel .device-preview-tag')?.textContent==='示例'`,
          ),
        'a sample preview is tagged 示例',
      )
    }
    await openSettings()
    assert.equal(
      await main.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.ambient-settings .ambient-group input[type=checkbox]')).every(b=>b.disabled||b.closest('label').textContent.includes('附品牌'))`,
      ),
      true,
      'sub-feature switches wait for a key too',
    )
    await setField('.ambient-settings input[placeholder="00700.hk"]', 'bad')
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelector('.ambient-settings .ambient-field-error')?.textContent`,
      ),
      '格式：00700.hk',
      'an invalid symbol shows the format inline',
    )
    await setField('.ambient-settings input[placeholder="00700.hk"]', '00700.hk, 600519.sh')
    assert.equal(
      await main.webContents.executeJavaScript(
        `Boolean(document.querySelector('.ambient-settings .ambient-field-error'))`,
      ),
      false,
    )
    // The key settings live in each 元宝搜索 plugin's own details.
    await category('holiday')
    await click(main, '.ambient-yuanbao > summary')
    const keyForm = (await main.webContents.executeJavaScript(
      `(()=>{const f=document.querySelector('.ambient-yuanbao-keys');const inputs=Array.from(f.querySelectorAll('input'));return {types:inputs.map(i=>i.type),autocomplete:inputs.map(i=>i.autocomplete),placeholders:inputs.map(i=>i.placeholder),save:f.querySelector('button[type=submit]').disabled,buttons:Array.from(f.querySelectorAll('button')).map(b=>[b.textContent,b.disabled])}})()`,
    )) as {
      types: string[]
      autocomplete: string[]
      placeholders: string[]
      save: boolean
      buttons: [string, boolean][]
    }
    assert.deepEqual(
      keyForm.types,
      ['password', 'password'],
      'SecretId and SecretKey are password fields',
    )
    assert.ok(
      keyForm.autocomplete.every((v) => v === 'off') && keyForm.placeholders.every((v) => v === ''),
      'without a saved key nothing claims 已保存',
    )
    assert.deepEqual(
      keyForm.buttons,
      [
        ['保存', true],
        ['清除', true],
        ['测试连接', true],
      ],
      'save, clear and test wait for input or a saved key',
    )
    // The key panel stays inside the plugin details at 1440 and 720: no clipped labels, no sideways overflow.
    for (const [width, height] of [
      [1440, 900],
      [720, 600],
    ] as const) {
      main.setContentSize(width, height)
      await wait(400)
      const fit = (await main.webContents.executeJavaScript(
        `(()=>{const d=document.querySelector('.ambient-yuanbao'),c=document.querySelector('.plugin-details-layer:not([hidden]) .plugin-details');const seg=Array.from(d.querySelectorAll('.page-segmented button')).map(b=>[b.textContent,Math.round(b.getBoundingClientRect().height)]);return {overflow:d.scrollWidth-d.clientWidth,card:c.scrollWidth-c.clientWidth,seg,page:document.documentElement.scrollWidth-innerWidth}})()`,
      )) as { overflow: number; card: number; seg: [string, number][]; page: number }
      assert.ok(
        fit.overflow <= 1 && fit.card <= 1 && fit.page <= 1 && fit.seg.every(([, h]) => h <= 36),
        `元宝搜索 settings fit at ${width}: ${JSON.stringify(fit)}`,
      )
      assert.deepEqual(
        fit.seg.map(([t]) => t),
        ['SecretId/Key', 'API Key'],
        'short segment labels',
      )
    }
    main.setContentSize(1120, 780)
    await wait(350)
    await click(main, '.ambient-yuanbao .page-segmented button:nth-child(2)')
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelectorAll('.ambient-yuanbao-keys input[type=password]').length`,
      ),
      1,
      'API Key mode has one field',
    )
    // A fictitious key submits once and is gone from the page immediately, whatever the host answers.
    await setField('.ambient-yuanbao-keys input[type=password]', 'AKIDEXAMPLE-fictitious')
    await button(main, '保存')
    assert.equal(
      await main.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.ambient-yuanbao-keys input')).every(i=>i.value==='')`,
      ),
      true,
      'the key field is emptied on save',
    )
    await wait(400)
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.body.innerText.includes('AKIDEXAMPLE-fictitious')||document.body.innerHTML.includes('AKIDEXAMPLE-fictitious')`,
      ),
      false,
      'the key is not left anywhere in the page',
    )
    await click(main, '.ambient-yuanbao > summary')
    for (const gone of [
      '保存推送设置',
      '预览画面',
      '当前目标画面',
      '规则修改后立即保存',
      '图片拖进此页即可导入',
      '内容预览',
      '400 × 300',
      '仅供预览',
      '预览说明',
      '2 倍检查',
    ])
      assert.equal(
        await main.webContents.executeJavaScript(
          `document.body.innerText.includes(${JSON.stringify(gone)})`,
        ),
        false,
        'removed copy is gone: ' + gone,
      )
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelector('.ambient-panel select[aria-label="选择内容"]')`,
      ),
      null,
      'no item dropdown',
    )
    // The social row switch is the existing xEnabled / memeEnabled rule pair.
    await click(main, '.plugin-row[data-plugin-id="local:social"] .plugin-switch')
    await until(
      () => !ambient.snapshot().config.xEnabled && !ambient.snapshot().config.memeEnabled,
      'row switch saves on its own',
    )
    await until(
      () =>
        main!.webContents.executeJavaScript(
          `document.querySelector('.page-saved')?.textContent==='已保存'`,
        ),
      'saved confirmation',
    )
    assert.equal(ambient.current(), undefined, 'saving rules does not select content')
    await click(main, '.plugin-row[data-plugin-id="local:social"] .plugin-switch')
    await until(
      () => ambient.snapshot().config.xEnabled && !ambient.snapshot().config.memeEnabled,
      'row switch restores the remembered pair (X only), not both',
    )
    await category('social')
    await openSettings()
    for (const label of ['保存密钥', '清除密钥', '检查新内容'])
      assert.ok(
        await main.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('.ambient-settings button')).some(b=>b.textContent.trim()===${JSON.stringify(label)})`,
        ),
        'X settings keep ' + label,
      )
    await click(main, '.ambient-group[aria-label=Meme] .page-switch input')
    await until(
      () => ambient.snapshot().config.memeEnabled === true,
      'meme switch inside settings saves',
    )
    // Meme only: turning the row off and on again must never re-enable X.
    await click(main, '.ambient-group[aria-label="X 贴文"] .page-switch input')
    await until(
      () => !ambient.snapshot().config.xEnabled && ambient.snapshot().config.memeEnabled,
      'meme-only state',
    )
    await click(main, '.plugin-row[data-plugin-id="local:social"] .plugin-switch')
    await until(
      () => !ambient.snapshot().config.xEnabled && !ambient.snapshot().config.memeEnabled,
      'row off from meme-only',
    )
    await click(main, '.plugin-row[data-plugin-id="local:social"] .plugin-switch')
    await until(
      () => !ambient.snapshot().config.xEnabled && ambient.snapshot().config.memeEnabled,
      'row on restores meme only; X stays off',
    )
    // Back to the fixture state: X on, meme off.
    await click(main, '.ambient-group[aria-label="X 贴文"] .page-switch input')
    await click(main, '.ambient-group[aria-label=Meme] .page-switch input')
    await until(
      () => ambient.snapshot().config.xEnabled && !ambient.snapshot().config.memeEnabled,
      'fixture state restored',
    )
    assert.deepEqual(
      await main.webContents.executeJavaScript(
        `(()=>{const r=document.querySelector('.plugin-row[data-plugin-id="local:local"]');return [r.querySelector('.plugin-state-label').textContent,Boolean(r.querySelector('.plugin-switch'))]})()`,
      ),
      ['仅手动', false],
      'the manual-only plugin carries a 仅手动 state instead of a switch',
    )
    await button(main, '检查新内容')
    await until(
      () => ambient.snapshot().cards.filter((c) => c.kind === 'x').length === 1,
      'content fixture',
    )
    await click(main, '.ambient-item')
    await previewReady()
    await capture('updates')
    await category('concept')
    await previewReady()
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelector('.ambient-panel .device-preview-tag')?.textContent`,
      ),
      '预览',
      'an item that is not on the screen is tagged 预览',
    )
    // Reference for the pet page: where the display button sits for a normal category at scroll top.
    const conceptFirstScreen = (await main.webContents.executeJavaScript(`(() => {
      for(let e=document.querySelector('.ambient-panel');e;e=e.parentElement)e.scrollTop=0;
      const r=Array.from(document.querySelectorAll('button')).find(b=>b.getClientRects().length&&b.textContent.trim()===${JSON.stringify(TEMP)}).getBoundingClientRect();
      return {top:r.top,bottom:r.bottom,height:window.innerHeight}
    })()`)) as { top: number; bottom: number; height: number }
    await showTemp()
    assert.equal(ambient.current()?.kind, 'concept')
    assert.equal(ambient.current()?.manual, true)
    await until(
      () =>
        main!.webContents.executeJavaScript(
          `document.querySelector('.plugin-ink-preview .ambient-message')?.textContent.includes('已临时展示')`,
        ),
      'temporary display confirmed',
    )
    await until(
      () =>
        main!.webContents.executeJavaScript(
          `document.querySelector('.ambient-panel .device-preview-tag')?.textContent==='当前画面'`,
        ),
      'the item on the screen is tagged 当前画面',
    )
    assert.equal(
      await main.webContents.executeJavaScript(`(() => {
      document.querySelector('.plugin-preview-actions').scrollIntoView({block:'center'});
      const r=document.querySelector('.plugin-ink-preview .ambient-message').getBoundingClientRect();
      return r.top>=0 && r.bottom<=window.innerHeight;
    })()`),
      true,
      'content result is visible when its display button is visible',
    )
    await capture('multimedia-concept')
    await category('prompt')
    await previewReady()
    await showTemp()
    assert.equal(ambient.current()?.kind, 'prompt')
    await category('local')
    await main.webContents.executeJavaScript(
      `(() => { const t=document.querySelector('#ambient-note');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'TEST NOTE — pause, then choose one useful task.');t.dispatchEvent(new Event('input',{bubbles:true})); })()`,
    )
    await button(main, '保存并预览')
    await until(() => ambient.snapshot().cards.some((c) => c.kind === 'note'), 'saved local note')
    await previewReady()
    await showTemp()
    assert.equal(ambient.current()?.kind, 'note')
    await capture('multimedia-note')
    await button(main, '移除')
    assert.equal(ambient.current(), undefined)
    const imageBytes = Array.from(
      nativeImage
        .createFromBitmap(Buffer.alloc(80 * 120 * 4, 255), { width: 80, height: 120 })
        .toPNG(),
    )
    await main.webContents.executeJavaScript(
      `(() => {const transfer = new DataTransfer();transfer.items.add(new File([new Uint8Array(${JSON.stringify(imageBytes)})], 'TEST-portrait.png', {type:'image/png'}));document.querySelector('.ambient-panel').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`,
    )
    await until(
      () => ambient.snapshot().cards.some((c) => c.kind === 'image'),
      'dragged image is imported',
    )
    assert.equal(ambient.current(), undefined, 'importing never changes the e-ink screen by itself')
    await until(
      () =>
        main!.webContents.executeJavaScript(
          `document.querySelector('.plugin-ink-preview .ambient-message')?.textContent.includes('已导入 1 张图片')`,
        ),
      'import confirmed',
    )
    await previewReady()
    await showTemp()
    assert.equal(ambient.current()?.kind, 'image', 'the imported picture is shown on request')
    assert.equal(ambient.current()?.imageHex?.length, 19968)
    await capture('multimedia-image')
    ambient.dismiss()
    await wait()
    assert.equal(ambient.current(), undefined)
    // Pixel pets: the page lists five pets, shows red ink in the preview, and displays one on the screen.
    const petStats = () =>
      main!.webContents.executeJavaScript(`(() => {
      const canvas=document.querySelector('.ambient-panel .device-preview canvas.device-screen');
      const d=canvas.getContext('2d').getImageData(0,0,400,300).data;let red=0,hash=0;
      for(let i=0;i<d.length;i+=4){if(d[i]===190&&d[i+1]===30&&d[i+2]===45)red++;hash=(hash*31+d[i]+d[i+1]*3+d[i+2]*7)>>>0}
      return {red,hash,state:document.querySelector('.ambient-panel .device-preview').getAttribute('data-render-state')}
    })()`) as Promise<{ red: number; hash: number; state: string }>
    // Every pet option must show its name and full one-line character note without truncation.
    const assertPetTextFits = async (label: string) => {
      const cells = (await main!.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.ambient-pet-option')).map(o=>Array.from(o.querySelectorAll('strong,span')).map(e=>({text:e.textContent,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth})))`,
      )) as { text: string; scrollWidth: number; clientWidth: number }[][]
      assert.equal(cells.length, 5)
      for (const row of cells) {
        assert.equal(row.length, 2)
        for (const e of row)
          assert.ok(
            e.text && e.scrollWidth <= e.clientWidth,
            label + ' text is not truncated: ' + JSON.stringify(e),
          )
      }
    }
    const petChecked = () =>
      main!.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.ambient-pet-option')).map(b=>b.getAttribute('aria-checked'))`,
      ) as Promise<string[]>
    await category('pet')
    await openSettings()
    await previewReady()
    assert.deepEqual(
      await petChecked(),
      ['true', 'false', 'false', 'false', 'false'],
      'first pet is chosen by default',
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelectorAll('.ambient-pet-option canvas').length`,
      ),
      5,
      'five pet thumbnails',
    )
    await click(main, '.ambient-pet-option:nth-child(1)')
    await until(async () => {
      const s = await petStats()
      return s.state === 'ready' && s.red > 0
    }, 'pet preview draws red pixels')
    const firstPet = await petStats()
    assert.ok(firstPet.red >= 100, 'preview paints rgb(190,30,45), got ' + firstPet.red)
    // The primary action stays on the first screen at the default 1120 x 780 window, like other categories.
    const firstScreen = (await main.webContents.executeJavaScript(`(() => {
      for(let e=document.querySelector('.ambient-panel');e;e=e.parentElement)e.scrollTop=0;
      const r=Array.from(document.querySelectorAll('button')).find(b=>b.getClientRects().length&&b.textContent.trim()===${JSON.stringify(TEMP)}).getBoundingClientRect();
      return {top:r.top,bottom:r.bottom,height:window.innerHeight}
    })()`)) as { top: number; bottom: number; height: number }
    writeFileSync(
      join(output, 'first-screen.json'),
      JSON.stringify({ concept: conceptFirstScreen, pet: firstScreen }),
    )
    // Five pet cards with real thumbnails need a little more height than the one-line concept row.
    assert.ok(
      Math.abs(firstScreen.top - conceptFirstScreen.top) <= 24,
      'pet page keeps the display button where the concept page has it: ' +
        JSON.stringify({ pet: firstScreen, concept: conceptFirstScreen }),
    )
    await click(main, '.ambient-pet-option:nth-child(2)')
    assert.deepEqual(
      await petChecked(),
      ['false', 'true', 'false', 'false', 'false'],
      'selection moves to the second pet',
    )
    await until(async () => {
      const s = await petStats()
      return s.state === 'ready' && s.hash !== firstPet.hash && s.red > 0
    }, 'second pet preview')
    assert.match(
      await main.webContents.executeJavaScript(
        `document.querySelector('.ambient-pet-option[aria-checked=true]').textContent`,
      ),
      /已选/,
    )
    await showTemp()
    assert.equal(ambient.current()?.kind, 'pet')
    assert.equal(ambient.current()?.pet?.id, 'yaya')
    assert.ok(ambient.current()?.red, 'the pet on screen carries a red plane')
    assert.ok(
      withAmbient(device().status, ambient.current()).ambient?.red,
      'device status exposes ambient.red',
    )
    await until(async () => (await petStats()).red > 0, 'live target shows red')
    await assertPetTextFits('1120')
    await capture('multimedia-pet')
    await assertCanvasPure('pet 1120')
    // ui-acceptance viewports with a pet chosen; the window goes back to 1120 x 780 afterwards.
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [390, 844],
    ] as const) {
      main.setContentSize(width, height)
      await wait(450)
      const overflow = (await main.webContents.executeJavaScript(
        `document.documentElement.scrollWidth-window.innerWidth`,
      )) as number
      if (width >= 1024)
        assert.ok(overflow <= 1, 'no horizontal page scroll at ' + width + ': ' + overflow)
      assert.equal(
        await main.webContents.executeJavaScript(
          `document.querySelectorAll('.ambient-pet-option').length`,
        ),
        5,
      )
      if (width >= 1024) await assertPetTextFits(String(width))
      if (width >= 1024) await assertCanvasPure('pet ' + width)
      await capture('multimedia-pet-' + width)
    }
    main.setContentSize(1120, 780)
    await wait(350)
    await click(main, '.ambient-pet-option:nth-child(1)')
    assert.deepEqual(await petChecked(), ['true', 'false', 'false', 'false', 'false'])
    await assertPetTextFits('1120 first pet chosen')
    ambient.dismiss()
    await wait()
    assert.equal(ambient.current(), undefined)
    // Calendar: a category with only its own switch, opening on today's card with its info line.
    await category('calendar')
    await previewReady()
    const calendarPage = (await main.webContents.executeJavaScript(`(() => ({
      selected:document.querySelector('.plugin-row[data-selected=true]')?.getAttribute('data-plugin-id'),
      info:document.querySelector('.ambient-calendar-info')?.textContent??'',
      infoBox:(()=>{for(let e=document.querySelector('.ambient-panel');e;e=e.parentElement)e.scrollTop=0;const r=document.querySelector('.ambient-calendar-info')?.getBoundingClientRect();return r?{top:r.top,bottom:r.bottom,height:window.innerHeight}:null})(),
      hint:document.querySelector('.ambient-calendar-info')?.getAttribute('title')??'',
      picker:Boolean(document.querySelector('.ambient-pet-picker')),
      settings:Boolean(document.querySelector('.ambient-settings')),
      toggle:Boolean(document.querySelector('.plugin-row[data-plugin-id="local:calendar"] .plugin-switch'))
    }))()`)) as {
      selected: string
      info: string
      infoBox: { top: number; bottom: number; height: number } | null
      hint: string
      picker: boolean
      settings: boolean
      toggle: boolean
    }
    assert.equal(calendarPage.selected, 'local:calendar', 'calendar plugin is selected')
    assert.equal(calendarPage.picker, false, 'one card a day needs no picker')
    assert.equal(calendarPage.settings, false, 'calendar has no extra options')
    assert.match(
      calendarPage.info,
      /^\d+月\d+日 周[一二三四五六日] · 农历.+ · 第\d+周/,
      'info line: date, lunar, week',
    )
    assert.match(calendarPage.hint, /固件 0\.0\.29/)
    assert.match(
      calendarPage.info,
      /(假期中|距 .+ 还有 \d+ 天|暂无下一个假日数据)$/,
      'info line ends with the next holiday or says there is none',
    )
    assert.ok(
      calendarPage.infoBox &&
        calendarPage.infoBox.top >= 0 &&
        calendarPage.infoBox.bottom <= calendarPage.infoBox.height,
      'calendar info is on the first screen at 1120x780: ' + JSON.stringify(calendarPage.infoBox),
    )
    assert.ok(calendarPage.toggle, 'calendar keeps its own switch')
    await showTemp()
    assert.equal(ambient.current()?.kind, 'calendar')
    assert.equal(ambient.current()?.manual, true)
    assert.equal(withAmbient(device().status, ambient.current()).ambient?.layout, 'calendar')
    assert.ok(
      withAmbient(device().status, ambient.current()).ambient?.calendar,
      'device status exposes ambient.calendar',
    )
    await capture('multimedia-calendar')
    await assertCanvasPure('calendar 1120')
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
    ] as const) {
      main.setContentSize(width, height)
      await wait(450)
      const overflow = (await main.webContents.executeJavaScript(
        `document.documentElement.scrollWidth-window.innerWidth`,
      )) as number
      assert.ok(
        overflow <= 1,
        'no horizontal page scroll on the calendar page at ' + width + ': ' + overflow,
      )
      await assertCanvasPure('calendar ' + width)
      await capture('multimedia-calendar-' + width)
    }
    main.setContentSize(1120, 780)
    await wait(350)
    ambient.dismiss()
    await wait()
    assert.equal(ambient.current(), undefined)
    await click(main, '[data-view=settings]')
    assert.equal(
      await main.webContents.executeJavaScript(`document.body.textContent.includes('屏幕工作台')`),
      false,
      'settings no longer lists the screen workbench',
    )
    await main.webContents.executeJavaScript(`window.codepulse.openSurface('screen')`)
    await wait()
    await until(
      () => BrowserWindow.getAllWindows().some((w) => w.getTitle().includes('屏幕工作台')),
      'screen window',
    )
    const screenWindow = BrowserWindow.getAllWindows().find((w) =>
      w.getTitle().includes('屏幕工作台'),
    )!
    await until(
      () =>
        screenWindow.webContents.executeJavaScript(
          `document.querySelector('.screen-live .device-preview')?.getAttribute('data-render-state')==='ready'`,
        ),
      'real Wasm screen pixels',
    )
    const render = await createDeviceRenderer(
      readFileSync('apps/desktop/src/renderer/src/device-preview/renderer.wasm'),
    )
    const rendered = await screenWindow.webContents.executeJavaScript(
      `Array.from(document.querySelector('.screen-live canvas').getContext('2d').getImageData(0,0,400,300).data)`,
    )
    assert.deepEqual(rendered, Array.from(frameToRgba(render(device().status))))
    await button(screenWindow, '置顶')
    const nativePinApplied = screen.state().pinned
    if (!nativePinApplied)
      assert.ok(
        await screenWindow.webContents.executeJavaScript(
          `document.body.textContent.includes('系统未应用置顶设置')`,
        ),
      )
    await assert.rejects(
      main.webContents.executeJavaScript(`window.codepulse.setWorkbenchWindow({pinned:true})`),
    )
    await button(screenWindow, '显示配置')
    await button(screenWindow, '工作状态')
    await main.webContents.executeJavaScript(
      `window.codepulse.setDeviceDisplay({...${JSON.stringify(config)},metric:'used'})`,
    )
    await wait()
    assert.ok(
      await screenWindow.webContents.executeJavaScript(
        `document.body.textContent.includes('保留你的未保存修改')`,
      ),
    )
    await button(screenWindow, '当前画面')
    ambient.dismiss()
    await wait(500)
    assert.ok(
      await screenWindow.webContents.executeJavaScript(
        `document.querySelector('.screen-context').textContent.includes('开销看板')`,
      ),
    )
    writeFileSync(join(output, 'device.json'), JSON.stringify(device().status, null, 2))
    await button(screenWindow, '专注展示')
    if (captureAll) {
      await wait(100)
      writeFileSync(
        join(output, 'screen.png'),
        (await screenWindow.webContents.capturePage()).toPNG(),
      )
    }
    await button(screenWindow, '退出展示')
    await new Promise<void>((resolve) => {
      screenWindow.webContents.once('did-finish-load', () => resolve())
      screenWindow.webContents.reload()
    })
    await until(
      () =>
        screenWindow.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('button')).some(b=>b.textContent===${JSON.stringify(nativePinApplied ? '已置顶' : '置顶')})`,
        ),
      'pin state after reload',
    )
    const savedOrder = JSON.stringify({
      version: 1,
      workspaceKeys: ['f:/example/new-project', 'f:/example/codepulse'],
    })
    await main.webContents.executeJavaScript(
      `localStorage.setItem('codepulse:project-order-v1',${JSON.stringify(savedOrder)})`,
    )
    const next = hub.snapshot()
    next.agents = [
      ...next.agents,
      {
        ...next.agents[0]!,
        workspacePath: 'F:/example/new-project',
        externalSessionId: 'order-fixture',
      },
    ]
    screen.broadcast('codepulse:status', next)
    await wait()
    assert.equal(
      await main.webContents.executeJavaScript(
        `localStorage.getItem('codepulse:project-order-v1')`,
      ),
      savedOrder,
    )
    await click(main, '[data-view=settings]')
    assert.equal(
      await main.webContents.executeJavaScript(
        `Boolean(document.querySelector('.product-topbar'))`,
      ),
      false,
    )
    assert.ok(
      await main.webContents.executeJavaScript(
        `Boolean(document.querySelector('.settings-embedded'))`,
      ),
    )
    voiceFixture.ink.deviceAvailable = true
    broadcast('codepulse:work-voice', voiceFixture)
    await until(
      () =>
        main!.webContents.executeJavaScript(
          `(() => { const panels=Array.from(document.querySelectorAll('.settings-embedded .work-voice-options')); return panels.length===2&&panels.every(panel=>panel.querySelector('input')&&!panel.querySelector('input').matches(':disabled')) })()`,
        ),
      'voice preferences loaded',
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelectorAll('.product-control .work-voice-options,.product-control .product-state-guide').length`,
      ),
      0,
      'surface pages no longer contain global settings',
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelector('.settings-embedded .product-state-guide-toggle').getAttribute('aria-expanded')`,
      ),
      'false',
    )
    await click(main, '.settings-embedded .product-state-guide-toggle')
    assert.ok(
      await main.webContents.executeJavaScript(
        `(() => { const toggle=document.querySelector('.settings-embedded .product-state-guide-toggle'), table=document.getElementById(toggle.getAttribute('aria-controls')); return toggle.getAttribute('aria-expanded')==='true' && !table.hidden && table.getClientRects().length>0 && table.textContent.includes('English') })()`,
      ),
    )
    await click(main, '.settings-embedded .product-state-guide-toggle')
    assert.equal(
      await main.webContents.executeJavaScript(
        `(() => { const toggle=document.querySelector('.settings-embedded .product-state-guide-toggle'); return toggle.getAttribute('aria-expanded')==='false' && document.getElementById(toggle.getAttribute('aria-controls')).hidden })()`,
      ),
      true,
    )
    const voiceSelector = (target: 'desktop' | 'ink') =>
      `.settings-embedded section[aria-label="${target === 'desktop' ? '工作台语音提醒' : '墨水屏设备语音提醒'}"]`
    const voiceSnapshot = () =>
      main!.webContents.executeJavaScript('window.codepulse.getWorkVoice()')
    const toggleVoice = async (target: 'desktop' | 'ink', enabled: boolean) => {
      await click(main!, `${voiceSelector(target)} input[type=checkbox]`)
      await until(
        async () => (await voiceSnapshot())[target].settings.enabled === enabled,
        `${target} voice opt-in through preload IPC`,
      )
      assert.equal(voiceCalls.at(-1)?.operation, 'set')
      assert.equal(voiceCalls.at(-1)?.target, target)
    }
    const pressVoiceButton = async (target: 'desktop' | 'ink', label: string) => {
      await main!.webContents.executeJavaScript(`(() => {
        const section=document.querySelector(${JSON.stringify(voiceSelector(target))}),button=Array.from(section.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)}&&!button.matches(':disabled'));
        if(!button)throw Error('Missing enabled voice action');button.click();
      })()`)
      await wait(120)
    }
    assert.deepEqual(
      [
        (await voiceSnapshot()).desktop.settings.enabled,
        (await voiceSnapshot()).ink.settings.enabled,
      ],
      [false, false],
    )
    for (const target of ['desktop', 'ink'] as const) {
      assert.equal(
        await main.webContents.executeJavaScript(
          `document.querySelector(${JSON.stringify(voiceSelector(target) + ' details')}).open`,
        ),
        false,
      )
      await click(main, `${voiceSelector(target)} summary`)
    }
    await toggleVoice('desktop', true)
    assert.equal((await voiceSnapshot()).ink.settings.enabled, false)
    await toggleVoice('ink', true)
    assert.equal((await voiceSnapshot()).desktop.settings.enabled, true)
    await toggleVoice('desktop', false)
    assert.equal((await voiceSnapshot()).ink.settings.enabled, true)
    await toggleVoice('ink', false)
    for (const target of ['desktop', 'ink'] as const) {
      const other = target === 'desktop' ? 'ink' : 'desktop'
      await toggleVoice(target, true)
      const previewBefore = readCount('work-voice-test')
      await pressVoiceButton(target, '试听语音')
      await until(
        () => Promise.resolve(readCount('work-voice-test') === previewBefore + 1),
        `${target} preview reaches IPC`,
      )
      assert.deepEqual(voiceCalls.at(-1), { operation: 'test', target })
      assert.equal((await voiceSnapshot())[target].speaking, true)
      assert.equal((await voiceSnapshot())[other].speaking, false)
      const stopBefore = readCount('work-voice-stop')
      await pressVoiceButton(target, target === 'desktop' ? '停止播报' : '取消待播')
      await until(
        () => Promise.resolve(readCount('work-voice-stop') === stopBefore + 1),
        `${target} stop reaches IPC`,
      )
      assert.deepEqual(voiceCalls.at(-1), { operation: 'stop', target })
      assert.equal((await voiceSnapshot())[target].speaking, false)
      assert.equal((await voiceSnapshot())[other].settings.enabled, false)
      await toggleVoice(target, false)
      await click(main, `${voiceSelector(target)} summary`)
    }
    voiceFixture.ink.deviceAvailable = false
    broadcast('codepulse:work-voice', voiceFixture)
    const voiceHeartbeatCount = () =>
      main!.webContents.executeJavaScript(
        `Array.from(window.__smokeHeartbeats.values()).filter(delay=>delay===${WORK_VOICE_HEARTBEAT_MS}).length`,
      )
    assert.equal(await voiceHeartbeatCount(), 1, 'the visible ink voice panel polls')
    await click(main, '[data-view=window]')
    assert.equal(
      await voiceHeartbeatCount(),
      0,
      'hidden voice settings stop polling on the workbench',
    )
    await click(main, '[data-view=ink]')
    assert.equal(await voiceHeartbeatCount(), 0, 'surface navigation never mounts voice settings')
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelectorAll('.product-control .work-voice-options,.product-control .product-state-guide').length`,
      ),
      0,
    )
    await click(main, '[data-view=settings]')
    assert.equal(await voiceHeartbeatCount(), 1, 'returning to settings resumes its voice reader')
    const savedSettingsSize = main.getContentSize()
    const settingsEvidenceState = () =>
      main!.webContents.executeJavaScript(`(() => {
        const page=document.querySelector('.settings-embedded'),voice=page.querySelector('.settings-work-voice-card'),guide=page.querySelector('.product-state-guide'),
          toggle=guide.querySelector('.product-state-guide-toggle'),table=document.getElementById(toggle.getAttribute('aria-controls')),
          rows=Array.from(voice.querySelectorAll('.work-voice-details')),scroll=page.closest('.product-scroll'),
          elements=[document.documentElement,document.querySelector('.product-content'),scroll,page,voice,guide,...rows.filter(row=>row.open).map(row=>row.querySelector('.work-voice-content')),...(table.hidden?[]:[table])],outer=[];
        for(let parent=scroll.parentElement;parent;parent=parent.parentElement) outer.push({element:parent.className||parent.tagName,top:parent.scrollTop,left:parent.scrollLeft});
        const textRect=(element)=>{const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){if(!node.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(node);return range.getBoundingClientRect()}throw Error('Missing settings label')},
          bounds=(element)=>{const box=element.getBoundingClientRect();return {top:box.top,bottom:box.bottom,left:box.left,right:box.right,height:box.height}},
          headings=Array.from(page.querySelectorAll('.page-card > h2')).map(heading=>{const box=textRect(heading);return {text:heading.textContent,left:box.left,insetTop:box.top-heading.parentElement.getBoundingClientRect().top}});
        return {viewport:[innerWidth,innerHeight],locale:document.documentElement.lang,theme:document.documentElement.dataset.theme,
          voiceExpanded:rows.map(row=>row.open),voiceLoaded:rows.every(row=>['Off','On','已关闭','已开启'].includes(row.querySelector('small').textContent)),
          guideOpen:toggle.getAttribute('aria-expanded')==='true'&&!table.hidden&&table.getClientRects().length>0,
          guideHidden:table.hidden,
          guideToggle:bounds(toggle),
          overflow:elements.map(element=>({element:element.className||element.tagName,width:element.clientWidth,scrollWidth:element.scrollWidth})),
          secondary:Array.from(voice.querySelectorAll('summary small,.product-caption')).map(element=>({font:getComputedStyle(element).fontSize,color:getComputedStyle(element).color})),
          voiceLabels:rows.map(row=>row.querySelector('summary > span').textContent),headings,
          rowAlignment:rows.map(row=>{const summary=row.querySelector('summary'),label=summary.querySelector('span');return {title:textRect(label).left,font:getComputedStyle(summary).fontSize,weight:getComputedStyle(summary).fontWeight,
            description:row.open?textRect(row.querySelector('.work-voice-content > p')).left:null,checkbox:row.open?row.querySelector('input').getBoundingClientRect().left:null}}),
          sharedNotes:voice.querySelectorAll(':scope > .product-caption').length,
          scroll:{top:scroll.scrollTop,left:scroll.scrollLeft,viewport:bounds(scroll),outer,window:[scrollX,scrollY],frame:bounds(document.querySelector('.product-frame'))},
          cards:{voice:bounds(voice),guide:bounds(guide)}};
      })()`)
    const expandSettingsCards = async (expanded: boolean) => {
      await main!.webContents.executeJavaScript(`(() => {
        for(const details of document.querySelectorAll('.settings-embedded .work-voice-details')) details.open=${expanded};
        const toggle=document.querySelector('.settings-embedded .product-state-guide-toggle');
        if(toggle.getAttribute('aria-expanded')!==${JSON.stringify(String(expanded))}) toggle.click();
      })()`)
      await until(async () => {
        const state = await settingsEvidenceState()
        return (
          state.voiceExpanded.length === 2 &&
          state.voiceExpanded.every((open: boolean) => open === expanded) &&
          state.voiceLoaded &&
          state.guideOpen === expanded
        )
      }, 'both voice outputs and the state table match the requested expansion state')
    }
    const assertSettingsFit = async (width: number, height: number, expanded = true) => {
      await until(async () => {
        const state = await settingsEvidenceState()
        return state.viewport[0] === width && state.viewport[1] === height
      }, `settings viewport ${width}x${height}`)
      const state = await settingsEvidenceState()
      assert.deepEqual(state.voiceExpanded, [expanded, expanded])
      assert.ok(state.voiceLoaded && state.guideOpen === expanded, JSON.stringify(state))
      assert.equal(state.guideHidden, !expanded)
      assert.ok(state.guideToggle.height >= 32, 'the state-guide toggle has a usable hit area')
      for (const element of state.overflow) {
        assert.ok(element.width > 0 && element.scrollWidth <= element.width, JSON.stringify(state))
      }
      const reference = state.headings[0]
      assert.ok(state.headings.length >= 2)
      for (const heading of state.headings) {
        assert.ok(Math.abs(heading.left - reference.left) <= 1, JSON.stringify(state.headings))
        assert.ok(
          Math.abs(heading.insetTop - reference.insetTop) <= 1,
          JSON.stringify(state.headings),
        )
      }
      for (const row of state.rowAlignment) {
        assert.ok(Math.abs(row.title - reference.left) <= 1, JSON.stringify(row))
        assert.deepEqual([row.font, row.weight], ['14px', '600'])
        if (expanded)
          assert.ok(
            Math.abs(row.title - row.description) <= 1 && Math.abs(row.title - row.checkbox) <= 1,
            JSON.stringify(row),
          )
      }
      assert.equal(state.sharedNotes, 2, 'shared voice guidance appears once below both outputs')
      return state
    }
    await expandSettingsCards(false)
    await assertSettingsFit(savedSettingsSize[0]!, savedSettingsSize[1]!, false)
    await expandSettingsCards(true)
    await assertSettingsFit(savedSettingsSize[0]!, savedSettingsSize[1]!)
    main.setContentSize(720, 480)
    const compactSettings = await assertSettingsFit(720, 480)
    writeFileSync(
      join(output, 'settings-compact-layout.json'),
      JSON.stringify(compactSettings, null, 2),
    )
    if (captureAll) {
      const evidence: Record<string, unknown>[] = []
      const savedTheme = compactSettings.theme
      const savedLocale = compactSettings.locale
      const savedScroll = await main.webContents.executeJavaScript(
        `document.querySelector('.settings-embedded').closest('.product-scroll').scrollTop`,
      )
      const ownSettingsInspector = !inspector.isAttached()
      if (ownSettingsInspector) inspector.attach('1.3')
      await inspector.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
      const positionSettingsEvidence = (selector: string | null = null, delta = 0) =>
        main!.webContents.executeJavaScript(`(async () => {
          const scroll=document.querySelector('.settings-embedded').closest('.product-scroll');
          for(let parent=scroll.parentElement;parent;parent=parent.parentElement){parent.scrollTop=0;parent.scrollLeft=0}
          document.scrollingElement.scrollTop=0;document.scrollingElement.scrollLeft=0;document.body.scrollTop=0;document.body.scrollLeft=0;window.scrollTo(0,0);
          const target=${JSON.stringify(selector)};
          if(target) scroll.scrollTop+=document.querySelector(target).getBoundingClientRect().top-scroll.getBoundingClientRect().top-8;
          scroll.scrollTop+=${delta};scroll.scrollLeft=0;
          let previous='';const started=performance.now();
          while(performance.now()-started<1000){
            await new Promise(requestAnimationFrame);
            const signature=JSON.stringify([scroll.scrollTop,scroll.scrollHeight,scroll.clientWidth,scroll.clientHeight,...Array.from(document.querySelectorAll('.settings-work-voice-card,.product-state-guide'),card=>{const box=card.getBoundingClientRect();return [box.top,box.bottom,box.left,box.right]}),...Array.from(document.querySelectorAll('.work-voice-details > summary,.product-state-guide-toggle'),row=>getComputedStyle(row,'::after').transform)]);
            if(signature===previous)return;previous=signature;
          }
          throw Error('Settings layout did not settle');
        })()`)
      const captureSettingsEvidence = async (
        name: string,
        theme: 'light' | 'dark',
        width: number,
        height: number,
        locale: 'zh' | 'en',
        expanded: boolean,
        condition = 'true',
      ) => {
        const verify = async () => {
          const state = await assertSettingsFit(width, height, expanded)
          assert.equal(state.theme, theme)
          assert.equal(state.locale, locale === 'zh' ? 'zh-CN' : 'en')
          assert.deepEqual(
            state.voiceLabels,
            locale === 'zh' ? ['工作台', '墨水屏设备'] : ['Workbench', 'E-paper Device'],
          )
          assert.deepEqual(state.scroll.window, [0, 0])
          assert.ok(
            state.scroll.outer.every(
              (parent: { top: number; left: number }) => parent.top === 0 && parent.left === 0,
            ),
            JSON.stringify(state.scroll),
          )
          assert.ok(
            Math.abs(state.scroll.frame.top) <= 1 && state.scroll.frame.bottom <= height + 1,
            JSON.stringify(state.scroll),
          )
          assert.equal(await main!.webContents.executeJavaScript(condition), true, name)
          return state
        }
        await until(() => main!.webContents.executeJavaScript(condition), name + ' state')
        const before = await verify()
        await capture(name, true)
        const after = await verify()
        assert.deepEqual(
          after.scroll,
          before.scroll,
          'capture preserves the verified scroll positions',
        )
        assert.deepEqual(
          after.cards,
          before.cards,
          'captured card bounds match the evidence record',
        )
        evidence.push({ file: name + '.png', ...before })
      }
      // Scroll through each entire card at the requested viewport, including all expanded text.
      const captureSettingsCard = async (
        card: 'voice' | 'guide',
        theme: 'light' | 'dark',
        width: number,
        height: number,
        locale: 'zh' | 'en',
      ) => {
        const selector = card === 'voice' ? '.settings-work-voice-card' : '.product-state-guide'
        await assertSettingsFit(width, height)
        await positionSettingsEvidence(selector)
        let covered = 0
        for (let part = 1; ; part++) {
          assert.ok(part <= 8, 'each settings card has bounded screenshot coverage')
          const tile = await main!.webContents.executeJavaScript(`(() => {
            const card=document.querySelector(${JSON.stringify(selector)}),scroll=card.closest('.product-scroll'),box=card.getBoundingClientRect(),viewport=scroll.getBoundingClientRect(),
              top=Math.max(viewport.top,0),bottom=Math.min(viewport.bottom,innerHeight);
            return {start:Math.max(0,top-box.top),end:Math.min(box.height,bottom-box.top),height:box.height,viewportHeight:bottom-top,scrollTop:scroll.scrollTop};
          })()`)
          assert.ok(
            tile.start <= covered + 1 && tile.end > covered,
            JSON.stringify({ covered, tile }),
          )
          const name = `settings-evidence-${locale}-${theme}-${width}-${card}-${part}`
          await captureSettingsEvidence(name, theme, width, height, locale, true)
          Object.assign(evidence.at(-1)!, { card, part, coverage: tile })
          covered = tile.end
          if (covered >= tile.height - 1) break
          await positionSettingsEvidence(null, tile.viewportHeight - 24)
          await until(
            () =>
              main!.webContents.executeJavaScript(
                `document.querySelector('.settings-embedded').closest('.product-scroll').scrollTop>${tile.scrollTop}`,
              ),
            'the next settings-card segment is visible',
          )
        }
      }
      try {
        for (const theme of ['light', 'dark'] as const) {
          await click(main, `.theme-swatch-${theme}`)
          await until(
            () =>
              main!.webContents.executeJavaScript(
                `document.documentElement.dataset.theme===${JSON.stringify(theme)}`,
              ),
            'settings evidence theme applied',
          )
          main.setContentSize(1120, 780)
          await expandSettingsCards(false)
          await assertSettingsFit(1120, 780, false)
          await positionSettingsEvidence('.settings-work-voice-card')
          const collapsedCardsVisible = `(() => {const page=document.querySelector('.settings-embedded'),scroll=page.closest('.product-scroll').getBoundingClientRect(),voice=page.querySelector('.settings-work-voice-card').getBoundingClientRect(),guide=page.querySelector('.product-state-guide').getBoundingClientRect();return voice.top>=scroll.top&&guide.bottom<=Math.min(scroll.bottom,innerHeight)})()`
          await captureSettingsEvidence(
            `settings-evidence-zh-${theme}-1120-collapsed`,
            theme,
            1120,
            780,
            'zh',
            false,
            collapsedCardsVisible,
          )
          for (const [name, row, preceding] of [
            ['voice-desktop', `${voiceSelector('desktop')} summary`, null],
            ['voice-ink', `${voiceSelector('ink')} summary`, `${voiceSelector('desktop')} summary`],
            [
              'guide',
              '.settings-embedded .product-state-guide-toggle',
              `${voiceSelector('ink')} summary`,
            ],
          ] as const) {
            await positionSettingsEvidence(row)
            const visible = `(() => {const row=document.querySelector(${JSON.stringify(row)}),box=row.getBoundingClientRect(),viewport=row.closest('.product-scroll').getBoundingClientRect();return box.top>=Math.max(viewport.top,0)+6&&box.bottom<=Math.min(viewport.bottom,innerHeight)-6})()`
            await hover(row)
            await captureSettingsEvidence(
              `settings-evidence-zh-${theme}-1120-${name}-hover`,
              theme,
              1120,
              780,
              'zh',
              false,
              `${visible} && (() => {const row=document.querySelector(${JSON.stringify(row)});return row.matches(':hover')&&!row.matches(':focus-visible')&&getComputedStyle(row).backgroundColor!=='rgba(0, 0, 0, 0)'})()`,
            )
            await inspector.sendCommand('Input.dispatchMouseEvent', {
              type: 'mouseMoved',
              x: 1096,
              y: 120,
            })
            await main.webContents.executeJavaScript(`(() => {
              const preceding=${JSON.stringify(preceding)},card=document.querySelector('.settings-work-voice-card'),
                previous=preceding?document.querySelector(preceding):Array.from(card.previousElementSibling.querySelectorAll('input:not(:disabled)')).at(-1);
              if(!previous)throw Error('Missing preceding settings control');previous.focus({preventScroll:true});
            })()`)
            await pressKey('Tab')
            await positionSettingsEvidence(row)
            await captureSettingsEvidence(
              `settings-evidence-zh-${theme}-1120-${name}-tab-focus`,
              theme,
              1120,
              780,
              'zh',
              false,
              `${visible} && (() => {const row=document.querySelector(${JSON.stringify(row)}),style=getComputedStyle(row);return document.activeElement===row&&row.matches(':focus-visible')&&!row.matches(':hover')&&style.outlineStyle==='solid'&&style.outlineWidth==='2px'})()`,
            )
            await main.webContents.executeJavaScript('document.activeElement.blur()')
          }
          main.setContentSize(720, 480)
          await assertSettingsFit(720, 480, false)
          await positionSettingsEvidence('.settings-work-voice-card')
          await captureSettingsEvidence(
            `settings-evidence-zh-${theme}-720-collapsed`,
            theme,
            720,
            480,
            'zh',
            false,
            collapsedCardsVisible,
          )
          await expandSettingsCards(true)
          for (const [width, height] of [
            [1120, 780],
            [940, 720],
            [720, 480],
          ] as const) {
            main.setContentSize(width, height)
            for (const card of ['voice', 'guide'] as const) {
              await captureSettingsCard(card, theme, width, height, 'zh')
            }
          }
        }
        await click(main, '.product-language-toggle')
        await until(
          () => main!.webContents.executeJavaScript(`document.documentElement.lang==='en'`),
          'English settings evidence applied',
        )
        for (const card of ['voice', 'guide'] as const) {
          await captureSettingsCard(card, 'dark', 720, 480, 'en')
        }
      } finally {
        if ((await settingsEvidenceState()).locale !== savedLocale)
          await click(main, '.product-language-toggle')
        await click(main, `.theme-swatch-${savedTheme}`)
        await positionSettingsEvidence()
        await main.webContents.executeJavaScript(
          `document.querySelector('.settings-embedded').closest('.product-scroll').scrollTop=${savedScroll}`,
        )
        await inspector.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false })
        if (ownSettingsInspector) inspector.detach()
        writeFileSync(join(output, 'settings-evidence.json'), JSON.stringify(evidence, null, 2))
      }
    }
    main.setContentSize(savedSettingsSize[0]!, savedSettingsSize[1]!)
    await expandSettingsCards(false)
    await click(main, '.product-language-toggle')
    await until(
      () => main!.webContents.executeJavaScript(`document.documentElement.lang==='en'`),
      'rail switches to English without opening Settings',
    )
    assert.ok(
      await main.webContents.executeJavaScript(
        `(() => { const page=document.querySelector('.settings-embedded'),rows=Array.from(page.querySelectorAll('.work-voice-details summary > span')); return rows.length===2 && rows[0].textContent==='Workbench' && rows[1].textContent==='E-paper Device' && page.querySelector('.product-state-guide > h2').textContent.includes('State guide') })()`,
      ),
      'moved settings retain English titles',
    )
    await click(main, '.product-language-toggle')
    await until(
      () => main!.webContents.executeJavaScript(`document.documentElement.lang==='zh-CN'`),
      'rail switches back to Chinese',
    )
    await click(main, '[data-view=settings]')
    await openInstalledPlugins(main)
    assert.equal(product.snapshot().view, 'plugins')
    await click(main, '[data-view=settings]')
    await click(main, '.theme-swatch-dark')
    await wait(500)
    await openCurrentSurface(main)
    await capture('control-dark')
    main.setSize(720, 600)
    await capture('compact')
    // A narrow rail keeps the state mark inside the device row, clear of its label and without an interactive hit area;
    // the words stay in the row's accessible name.
    const narrowMark = (await main.webContents.executeJavaScript(`(() => {
      const row=document.querySelector('.product-rail [data-view=ink]'),mark=row.querySelector('.product-nav-status'),
        label=row.querySelector('.product-nav-label'),box=mark.getBoundingClientRect(),rowBox=row.getBoundingClientRect(),
        text=document.createRange();
      text.selectNodeContents(label);
      return {display:getComputedStyle(mark).display, width:box.width,
        inside:box.left>=rowBox.left&&box.right<=rowBox.right&&box.top>=rowBox.top&&box.bottom<=rowBox.bottom,
        clear:text.getBoundingClientRect().left>=box.right, labelCut:label.scrollWidth>label.clientWidth,
        name:row.getAttribute('aria-label'), hidden:mark.getAttribute('aria-hidden'),
        controls:mark.querySelectorAll('button,a,input,[role=button],[tabindex]').length};
    })()`)) as {
      display: string
      width: number
      inside: boolean
      clear: boolean
      labelCut: boolean
      name: string
      hidden: string
      controls: number
    }
    assert.notEqual(narrowMark.display, 'none', 'narrow status keeps its mark visible')
    assert.ok(
      narrowMark.width > 0 && narrowMark.inside && narrowMark.clear,
      JSON.stringify(narrowMark),
    )
    assert.equal(narrowMark.labelCut, false, 'the narrow device row keeps its whole label')
    assert.equal(narrowMark.hidden, 'true')
    assert.equal(narrowMark.controls, 0)
    assert.ok(
      narrowMark.name.includes('墨水屏设备'),
      'narrow status retains its full accessible name',
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.documentElement.scrollWidth<=window.innerWidth`,
      ),
      true,
    )
    assert.equal(
      JSON.stringify(hub.snapshot().agents),
      before,
      'UI actions preserve canonical task state',
    )
    // Real assistant preload/IPC and an isolated database, without microphones or external calls.
    main.setSize(1120, 780)
    await click(main, '[data-view=settings]')
    await click(main, '.theme-swatch-light')
    await openInstalledPlugins(main, 'local:todo')
    await until(
      () =>
        main!.webContents.executeJavaScript(`Boolean(document.querySelector('.desk-task-form'))`),
      'assistant view',
    )
    await main.webContents.executeJavaScript(
      `(() => { const field=document.querySelector('.desk-task-form input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'测试待办 · 离线验证');field.dispatchEvent(new Event('input',{bubbles:true})); })()`,
    )
    await wait()
    await button(main, '添加待办')
    await until(() => assistantStore.list().length === 1, 'task form persists')
    await main.webContents.executeJavaScript(
      `(() => { const field=document.querySelector('.desk-assistant-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'10分钟后提醒我喝水');field.dispatchEvent(new Event('input',{bubbles:true})); })()`,
    )
    await wait()
    await button(main, '交给助手')
    await until(
      () =>
        main!.webContents.executeJavaScript(
          `Boolean(document.querySelector('.desk-assistant-draft'))`,
        ),
      'assistant proposal',
    )
    assert.equal(
      assistantStore.list().length,
      1,
      'AI suggestion does not mutate storage before confirmation',
    )
    await button(main, '确认执行')
    await until(() => assistantStore.list().length === 2, 'assistant confirmation persists')
    assert.ok(
      await main.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.desk-assistant button')).find(b=>b.textContent==='开始录音').disabled`,
      ),
      'microphone is opt-in',
    )
    await capture('assistant')
    await openCurrentSurface(main)
    await click(main, '[data-view=ink]')
    await selectPlayback('15')
    const previousPlan = structuredClone(product.snapshot().inkPlan)
    ambient.dismiss()
    await click(main, 'button[role=switch][aria-label="待办与提醒加入节目单"]')
    assert.deepEqual(product.snapshot().inkPlan, previousPlan, 'todo configuration remains a draft')
    await button(main, '应用')
    assert.equal(product.snapshot().inkPlan.mode, 'cycle')
    assert.deepEqual(product.snapshot().inkPlan.items, ['work', 'ambient', 'todos'])
    assistant.showOnInk()
    publishInk()
    await until(
      () =>
        main!.webContents.executeJavaScript(
          `document.querySelector('.ink-control-workspace .device-preview').getAttribute('data-render-state')==='ready'`,
        ),
      'production todo preview',
    )
    assert.equal(
      device().status.ambient?.items?.length,
      2,
      'temporary todo display uses the production checklist',
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelector('.device-preview-tag').textContent`,
      ),
      '临时展示',
    )
    await capture('control-todos')
    // The rail only reports the temporary state; the existing device-page control ends it.
    const endReads = readCount('ink-temporary-end'),
      viewBeforeEnd = product.snapshot().view
    assert.match(
      await main.webContents.executeJavaScript(
        `document.querySelector('.product-rail [data-view=ink]')?.getAttribute('aria-label')??''`,
      ),
      /临时展示/,
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelector('.product-rail .product-nav-status')?.classList.contains('is-filled')`,
      ),
      true,
      'a temporary display keeps the connected mark; its name carries the display details',
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `document.querySelectorAll('.product-rail .product-nav-status button').length`,
      ),
      0,
    )
    await click(main, '.ink-preview-card [data-ink-temporary-end]')
    await until(
      () => readCount('ink-temporary-end') === endReads + 1,
      'the device-page button calls endInkTemporary',
    )
    assert.equal(
      product.snapshot().view,
      viewBeforeEnd,
      'ending a temporary display never navigates',
    )
    await until(
      () =>
        main!.webContents.executeJavaScript(
          `!document.querySelector('.ink-preview-card [data-ink-temporary-end]')`,
        ),
      'the device-page action disappears when the temporary display ends',
    )
    assistant.showOnInk()
    publishInk()
    await until(
      () =>
        main!.webContents.executeJavaScript(
          `document.querySelector('.device-preview-tag')?.textContent==='临时展示'`,
        ),
      'temporary display restored for the following checks',
    )
    const beforeTemporaryEnd = structuredClone(product.snapshot().inkPlan)
    main.setContentSize(720, 480)
    await wait(350)
    await main.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.ink-preview-card button')).find(b=>b.textContent.trim()==='回到工作画面').scrollIntoView({block:'center'})`,
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `(() => {const b=Array.from(document.querySelectorAll('.ink-preview-card button')).find(b=>b.textContent.trim()==='回到工作画面');const r=b.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&!b.classList.contains('primary')})()`,
      ),
      true,
      'temporary exit stays reachable in the narrow window',
    )
    await click(main, '.ink-preview-card [data-ink-temporary-end]')
    assert.equal(assistant.temporaryInkUntil(), 0)
    assert.deepEqual(
      product.snapshot().inkPlan,
      beforeTemporaryEnd,
      'header temporary exit does not rewrite the playlist',
    )
    assert.equal(
      await main.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.ink-preview-card button')).some(b=>b.textContent.trim()==='回到工作画面')`,
      ),
      false,
    )
    main.setContentSize(1120, 780)
    await wait(350)
    assert.equal(
      JSON.stringify(hub.snapshot().agents),
      before,
      'assistant work never acknowledges programming tasks',
    )
    hub.ingest({
      id: 'shell-attention',
      source: 'codex',
      eventType: 'permission_request',
      externalSessionId: 'shell-ui',
      workspacePath: 'F:/example/codepulse',
      toolName: 'shell',
      timestamp: Date.now(),
    })
    const attentionState = JSON.stringify(hub.snapshot().agents)
    broadcast('codepulse:status', hub.snapshot())
    ambient.tick()
    // The sidebar shows no pending-review badge; attention lives on the surface pages.
    assert.equal(
      await main!.webContents.executeJavaScript(
        `Boolean(document.querySelector('.product-nav-count'))`,
      ),
      false,
    )
    await openCurrentSurface(main)
    assert.equal(
      product.snapshot().view,
      product.snapshot().target === 'hud'
        ? 'overlay'
        : product.snapshot().target === 'ink'
          ? 'ink'
          : 'window',
    )
    assert.equal(JSON.stringify(hub.snapshot().agents), attentionState)
    // Preview controls sit directly above the frame, right-aligned to its edge, on both pages; captured for review.
    for (const theme of captureAll ? (['light', 'dark'] as const) : (['light'] as const)) {
      await click(main, '[data-view=settings]')
      await click(main, `.theme-swatch-${theme}`)
      await wait(300)
      for (const [width, height] of captureAll
        ? [
            [1440, 900],
            [720, 480],
          ]
        : [[720, 480]]) {
        main.setContentSize(width!, height!)
        await wait(450)
        for (const page of ['ambient', 'ink'] as const) {
          if (page === 'ambient') {
            await openInstalledPlugins(main)
            await category('concept')
            await previewReady()
            if (captureAll) await wait(100)
          } else {
            await openCurrentSurface(main)
            await click(main, '[data-view=ink]')
            await until(
              () =>
                main!.webContents.executeJavaScript(
                  `document.querySelector('.product-control .device-preview')?.getAttribute('data-render-state')==='ready'`,
                ),
              'ink preview',
            )
          }
          const root = page === 'ambient' ? '.ambient-panel' : '.product-control'
          // Control: ⋯ shares the heading row with 连接设备. Desk content (no heading): ⋯ hugs the frame.
          const controls = (await main.webContents.executeJavaScript(
            `(()=>{const r=document.querySelector(${JSON.stringify(root)}),f=r?.querySelector('.device-preview-frame'),m=r?.querySelector('.device-preview-more');if(!f||!m)return null;
              const fr=f.getBoundingClientRect(),mr=m.getBoundingClientRect(),h=m.closest('.device-preview-header'),b=m.closest('.device-preview-framebar');
              const peers=h?[...h.querySelectorAll('.device-preview-header-actions > button')].filter(x=>x!==m&&x.getBoundingClientRect().height).map(x=>{const q=x.getBoundingClientRect();return q.top+q.height/2}):[];
              return {inHeader:Boolean(h),inBar:Boolean(b),moreMid:mr.top+mr.height/2,peers,more:mr.height,moreBottom:mr.bottom,frameTop:fr.top,moreRight:mr.right,frameRight:fr.right,
                visibleTag:[...r.querySelectorAll('.device-preview-tag')].some(t=>t.getBoundingClientRect().width>2)}})()`,
          )) as {
            inHeader: boolean
            inBar: boolean
            moreMid: number
            peers: number[]
            more: number
            moreBottom: number
            frameTop: number
            moreRight: number
            frameRight: number
            visibleTag: boolean
          } | null
          assert.ok(
            controls &&
              controls.more >= 32 &&
              !controls.visibleTag &&
              (page === 'ambient'
                ? controls.inBar &&
                  Math.abs(controls.moreRight - controls.frameRight) <= 3 &&
                  controls.frameTop >= controls.moreBottom - 1 &&
                  controls.frameTop - controls.moreBottom <= 12
                : controls.inHeader &&
                  controls.peers.every((mid) => Math.abs(mid - controls.moreMid) <= 2)),
            `${page} preview controls (${theme} ${width}): ${JSON.stringify(controls)}`,
          )
          await capture(`ia2-final-${theme}-${width}x${height}-${page}`)
        }
      }
    }
    main.setContentSize(1120, 780)
    await wait(350)
    await click(main, '[data-view=settings]')
    await click(main, '.theme-swatch-light')
    await wait(300)
    // The expected unauthorized native-window rejection is visible to Electron's console.
    const unexpected = errors.filter((e) => !e.includes('Only the screen window'))
    assert.deepEqual(unexpected, [])
    writeFileSync(
      join(output, 'result.json'),
      JSON.stringify(
        {
          passed: true,
          workVoiceSettings: true,
          views: 5,
          assistantTasks: true,
          todoPlan: true,
          contentVisibilityRoundTrip: true,
          consolidatedNavigation: true,
          groupedRail: true,
          reservedTitlebarHeight: shellTop.band?.height ?? null,
          nativeTitlebarHeight: shellTop.area?.height ?? null,
          fixtureWindowFrame: false,
          captureAll,
          durationMs: Date.now() - smokeStartedAt,
          captionButtonBoundsVerified: Boolean(shellTop.area),
          hiddenPageStatusPaused: true,
          fixedPixelResize: true,
          inspectionPixelEquality: true,
          visibleApply: true,
          stablePreviewFrames: true,
          previewMenuStable: true,
          previewCapRecovery: true,
          playlistSelect: true,
          rowSwitchIsolation: true,
          connectionOwnership: true,
          pendingOnlyApply: true,
          temporaryExit: true,
          invertedStyle: true,
          conceptCard: true,
          thoughtPrompt: true,
          personalNote: true,
          imageDrop: true,
          pixelPet: true,
          calendar: true,
          hudCoexistence: true,
          largePreview: true,
          independentScreen: true,
          draftPreserved: true,
          settingsShortcuts: true,
          globalAttention: true,
          canonicalStatePreserved: true,
          nativePinApplied,
          errors: unexpected,
        },
        null,
        2,
      ),
    )
    assistant.stop()
    assistantStore.close()
    ambient.stop()
    BrowserWindow.getAllWindows().forEach((w) => w.destroy())
    screen.destroy()
    clearTimeout(deadline)
    app.exit(0)
  } catch (error) {
    writeFileSync(
      join(output, 'failure.txt'),
      (error instanceof Error ? error.stack : String(error)) + '\n' + JSON.stringify(errors),
    )
    clearTimeout(deadline)
    app.exit(1)
  }
})
