// Captures every compact HUD style from the production renderer with synthetic tasks, and
// checks click-through at OS level with WindowFromPoint, which never moves the user's mouse.
// Disposable profile, no backend, no port 17888. Windows only for the click-through check.
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { StatusHub } from '@codepulse/core'
import {
  DEFAULT_HUD_SETTINGS,
  TurnState,
  type HudAppearanceSettings,
  type HudSurfaceStyle,
  type StatusSnapshot,
} from '@codepulse/shared'
import { HudSurface } from '../apps/desktop/src/main/hud-surface.js'

const output = resolve(process.env.CODEPULSE_CAPTURE_OUT ?? '.tmpshots/hud-capture/shots')
mkdirSync(output, { recursive: true })
app.setPath('userData', join(output, '..', 'profile-' + Date.now()))
app.disableHardwareAcceleration()
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const now = Date.now()

const quota = {
  rateLimits: {
    fiveHour: { usedPercent: 24, windowMinutes: 300 },
    sevenDay: { usedPercent: 26, windowMinutes: 10080 },
  },
}
const task = (
  id: string,
  agentType: 'claude_code' | 'codex',
  state: TurnState,
  extra: Record<string, unknown> = {},
) => ({
  agentType,
  externalSessionId: id,
  workspacePath: `F:/fixture/${id}`,
  state,
  lastEventAt: now - 1000,
  terminalAt: state === TurnState.DONE || state === TurnState.ERROR ? now - 1000 : undefined,
  unread: state === TurnState.DONE || state === TurnState.ERROR,
  toolCallCount: 3,
  needPermission: state === TurnState.WAITING_PERMISSION,
  needUserInput: false,
  turnStartedAt: now - 180_000,
  token: { contextUsedPercent: 31, contextWindow: 256_000, ...quota },
  ...extra,
})
const SCENES: Record<string, () => unknown[]> = {
  idle: () => [task('codepulse', 'claude_code', TurnState.IDLE)],
  run: () => [
    task('codepulse', 'claude_code', TurnState.TOOL_RUNNING, { activity: '正在执行 Bash' }),
    task('api-service', 'codex', TurnState.THINKING),
  ],
  wait: () => [
    task('codepulse', 'claude_code', TurnState.WAITING_PERMISSION, {
      activity: '请求运行 pnpm test',
    }),
    task('api-service', 'codex', TurnState.THINKING),
  ],
  done: () => [
    task('codepulse', 'claude_code', TurnState.DONE),
    task('release-notes', 'codex', TurnState.DONE),
  ],
  fail: () => [
    task('gitlab_single_pipe', 'claude_code', TurnState.ERROR, { activity: '构建失败' }),
    task('codepulse', 'claude_code', TurnState.TOOL_RUNNING, { activity: '正在执行 Bash' }),
    task('api-service', 'codex', TurnState.DONE),
  ],
  many: () => [
    task('codepulse', 'claude_code', TurnState.WAITING_PERMISSION, {
      activity: '请求运行 pnpm test',
    }),
    task('gitlab_single_pipe', 'claude_code', TurnState.DONE),
    task('api-service', 'codex', TurnState.THINKING),
    task('release-notes', 'codex', TurnState.TOOL_RUNNING, { activity: '正在编辑文件' }),
  ],
}
const OPENERS: Record<string, string> = {
  island: '.hud-c-island .hud-c-fill',
  edge: '.hud-c-tab',
  orb: '.hud-c-ball',
}

function windowFromPoint(x: number, y: number): string {
  const physical = screen.dipToScreenPoint({ x, y })
  const script = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class W {",
    '[StructLayout(LayoutKind.Sequential)] public struct P { public int X; public int Y; }',
    '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
    '[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(P p);',
    '[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f); }\';',
    '[void][W]::SetProcessDPIAware();',
    `$p = New-Object W+P; $p.X = ${physical.x}; $p.Y = ${physical.y};`,
    '[W]::GetAncestor([W]::WindowFromPoint($p), 2).ToInt64()',
  ].join(' ')
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return result.stdout.trim()
}

app
  .whenReady()
  .then(async () => {
    const hub = new StatusHub()
    let fixture: StatusSnapshot = { overall: 'idle', updatedAt: now, agents: [] }
    hub.snapshotForPresentation = () => fixture
    hub.snapshot = () => fixture
    for (const [channel, value] of [
      ['codepulse:detect-agents', []],
      ['codepulse:get-update', null],
      ['codepulse:shell-get', { hudAvailable: true }],
      ['codepulse:ack', true],
    ] as const)
      ipcMain.handle(channel, () => value)
    ipcMain.handle('codepulse:set-locale', (_e, locale) => locale)
    const hud = new HudSurface(
      hub,
      resolve('apps/desktop/out/hud'),
      join(output, '..', 'bind.json'),
    )
    ipcMain.handle('codepulse:get-status', () => hud.snapshot())
    ipcMain.handle('codepulse:set-window-theme', (e, theme) => hud.setTheme(e.sender, theme))
    hud.registerIpc()

    const errors: string[] = []
    let hidden = true
    app.on('browser-window-created', (_e, win) => {
      const real = { show: win.show.bind(win), showInactive: win.showInactive.bind(win) }
      win.show = () => (hidden ? undefined : real.show())
      win.showInactive = () => (hidden ? undefined : real.showInactive())
      win.webContents.on('console-message', (_ev, level, message) => {
        if (level >= 3) errors.push(message)
      })
    })
    const settings = (patch: Partial<HudAppearanceSettings>): void =>
      hud.syncSettings({ ...DEFAULT_HUD_SETTINGS, hudOpacity: 37, ...patch })
    settings({ hudStyle: 'island' })
    hud.reveal()
    const win = await (async () => {
      for (let i = 0; i < 100; i++) {
        const found = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'CodePulse HUD')
        if (found && !found.webContents.isLoading()) return found
        await wait(100)
      }
      throw new Error('HUD window did not load')
    })()
    await wait(500)
    win.webContents.setBackgroundThrottling(false)
    // A state change commits, then its morph starts: require two quiet checks in a row.
    const settle = async () => {
      await wait(250)
      let quiet = 0
      for (let i = 0; i < 40 && quiet < 2; i++) {
        const running = await win.webContents.executeJavaScript(
          `document.getAnimations().filter((a) => a instanceof CSSTransition && a.playState !== 'finished').length`,
        )
        quiet = running === 0 ? quiet + 1 : 0
        await wait(100)
      }
    }
    const set = async (style: HudSurfaceStyle, scene: string, theme: 'light' | 'dark') => {
      settings({ hudStyle: style, theme })
      fixture = { overall: 'idle', updatedAt: Date.now(), agents: SCENES[scene]!() as never }
      hud.broadcast('codepulse:status', fixture)
      await settle()
    }
    const capture = async (name: string) =>
      writeFileSync(join(output, name + '.png'), (await win.webContents.capturePage()).toPNG())
    const js = (code: string) => win.webContents.executeJavaScript(code)

    const size = (selector: string) =>
      js(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return document.querySelector('.hud-c')?.outerHTML.slice(0,300)??'no .hud-c';const r=e.getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)]})()`,
      )
    const expectSize = async (label: string, selector: string, expected: number[]) =>
      assert.deepEqual(await size(selector), expected, label)
    // Settled geometry, including open, close, then back to idle: no stale peek may survive.
    for (const theme of ['light', 'dark'] as const) {
      await set('island', 'idle', theme)
      await expectSize(`island idle ${theme}`, '.hud-c-island', [128, 36])
      await set('island', 'run', theme)
      await expectSize(`island run ${theme}`, '.hud-c-island', [216, 36])
      await set('island', 'wait', theme)
      await expectSize(`island wait ${theme}`, '.hud-c-island', [420, 64])
      await js(`document.querySelector('.hud-c-island .hud-c-fill').click()`)
      await settle()
      assert.equal(((await size('.hud-c-island')) as number[])[0], 460, `island open ${theme}`)
      await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`)
      await settle()
      await set('island', 'idle', theme)
      await expectSize(`island idle after open ${theme}`, '.hud-c-island', [128, 36])
      await set('pills', 'fail', theme)
      await expectSize(`pills big ${theme}`, '.hud-c-pill.is-big', [340, 92])
      assert.equal(
        await js(`document.querySelectorAll('.hud-c-pill.is-big').length`),
        1,
        `one big pill ${theme}`,
      )
    }

    const measured: Record<string, unknown> = {}
    for (const style of ['island', 'pills', 'edge', 'orb'] as const) {
      for (const theme of ['light', 'dark'] as const) {
        for (const scene of Object.keys(SCENES)) {
          await set(style, scene, theme)
          await capture(`${style}-${scene}-${theme}`)
        }
        const opener = OPENERS[style]
        if (opener) {
          await set(style, 'many', theme)
          await js(`document.querySelector(${JSON.stringify(opener)}).click()`)
          await settle()
          await capture(`${style}-open-${theme}`)
          await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`)
          await settle()
        }
      }
      measured[style] = await js(`(()=>{const s={fs:new Set(),fw:new Set(),r:new Set(),d:new Set()};
      for(const e of document.querySelectorAll('.hud-c, .hud-c *')){if(!e.getClientRects().length)continue;
      const c=getComputedStyle(e);if([...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())){s.fs.add(c.fontSize);s.fw.add(c.fontWeight)}
      if(c.borderRadius!=='0px')s.r.add(c.borderRadius);if(c.transitionDuration!=='0s')s.d.add(c.transitionDuration)}
      return {fontSizes:[...s.fs],weights:[...s.fw],radii:[...s.r],durations:[...s.d],
      overflow:document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight}})()`)
    }

    let clickThrough: unknown = 'skipped'
    if (process.platform === 'win32') {
      hidden = false
      await set('island', 'run', 'light')
      hud.reveal()
      await wait(600)
      const own = win.getNativeWindowHandle().readBigInt64LE().toString()
      const bounds = win.getBounds()
      const box = (await js(
        `(()=>{const r=document.querySelector('.hud-c-island').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      )) as { x: number; y: number }
      const pill = { x: bounds.x + Math.round(box.x), y: bounds.y + Math.round(box.y) }
      const move = (x: number, y: number) =>
        js(`document.dispatchEvent(new MouseEvent('mousemove',{clientX:${x},clientY:${y}}))`)
      await move(4, bounds.height - 4)
      await wait(200)
      const idleOverPill = windowFromPoint(pill.x, pill.y)
      const transparent = windowFromPoint(bounds.x + 4, bounds.y + bounds.height - 4)
      await move(box.x, box.y)
      await wait(200)
      const overPill = windowFromPoint(pill.x, pill.y)
      const ignoringOverPill = hud.debugState().ignoringMouse
      await move(4, bounds.height - 4)
      await wait(200)
      const left = windowFromPoint(pill.x, pill.y)
      clickThrough = { own, idleOverPill, transparent, overPill, ignoringOverPill, left }
      assert.notEqual(idleOverPill, own, 'an idle stage passes the pointer through')
      assert.notEqual(transparent, own, 'transparent stage area passes the pointer through')
      assert.equal(overPill, own, 'the drawn pill takes the pointer after the hit test')
      assert.equal(ignoringOverPill, false)
      assert.notEqual(left, own, 'leaving the pill restores click-through')
    }
    // The morph itself, sampled in a shown window: width must pass through in-between values.
    let morph: number[] = []
    if (!hidden) {
      await set('island', 'idle', 'light')
      fixture = { overall: 'idle', updatedAt: Date.now(), agents: SCENES.wait!() as never }
      hud.broadcast('codepulse:status', fixture)
      morph = (await js(
        `new Promise((done)=>{const el=document.querySelector('.hud-c-island'),out=[],t0=performance.now();(function tick(){out.push(Math.round(el.getBoundingClientRect().width));performance.now()-t0<600?setTimeout(tick,40):done(out)})()})`,
      )) as number[]
      assert.ok(
        new Set(morph).size >= 3,
        `island morph animates through in-between widths: ${morph.join(',')}`,
      )
    }
    writeFileSync(
      join(output, 'report.json'),
      JSON.stringify({ clickThrough, morph, measured, errors }, null, 2),
    )
    assert.deepEqual(errors, [])
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
