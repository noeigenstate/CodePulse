import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DEFAULT_HUD_SETTINGS,
  HUD_SURFACE_STYLES,
  normalizeHudSettings,
  DEFAULT_INK_PLAN,
  normalizeInkPlan,
  normalizeShellPreferences,
  productTargets,
  type ShellPreferences,
} from '@codepulse/shared'
import { ProductShell, shellPreferenceStore } from '../apps/desktop/src/main/product-shell.js'
import { DeviceViewLeases } from '../apps/desktop/src/main/device-view-leases.js'
import { registerProductIpc } from '../apps/desktop/src/main/product-ipc.js'

function fixture(input?: unknown) {
  let hud = true,
    visible = false,
    failSave = false
  const calls: string[] = [],
    saved: ShellPreferences[] = []
  const shell = new ProductShell(
    input,
    (p) => {
      if (failSave) throw new Error('disk')
      saved.push({ ...p })
    },
    {
      hudAvailable: () => hud,
      hudVisible: () => visible,
      focusMode: (focused) => calls.push(focused ? 'focus' : 'expand'),
      standard: () => calls.push('standard'),
      hud: () => {
        visible = true
        calls.push('hud')
      },
      screen: () => calls.push('screen'),
      hideStandard: () => calls.push('hide-standard'),
      hideHud: () => {
        visible = false
        calls.push('hide-hud')
      },
    },
    () => calls.push('changed'),
  )
  return {
    shell,
    calls,
    saved,
    withoutHud: () => {
      hud = false
    },
    failSave: () => {
      failSave = true
    },
  }
}
test('ink plans retain work first, deduplicate slots and accept five-minute dwell', () => {
  const plan = normalizeInkPlan({
    mode: 'cycle',
    fixed: 'todos',
    items: ['todos', 'ambient', 'todos'],
    intervalMinutes: 5,
  })
  assert.deepEqual(plan, {
    mode: 'cycle',
    fixed: 'work',
    items: ['work', 'todos', 'ambient'],
    intervalMinutes: 5,
  })
  assert.equal(normalizeInkPlan({ intervalMinutes: 7 }).intervalMinutes, 15)
  assert.equal(normalizeInkPlan({ intervalMinutes: '5' }).intervalMinutes, 15)
  assert.equal(normalizeInkPlan({ mode: 'single', fixed: 'work' }).fixed, 'work')
  assert.deepEqual(normalizeInkPlan({ items: [] }).items, ['work'])
  assert.deepEqual(normalizeInkPlan({ items: ['invalid'] }).items, ['work'])
})
test('legacy non-work fixed plans migrate once to a cycle with work and that content', () => {
  for (const fixed of ['ambient', 'todos']) {
    const plan = normalizeInkPlan({
      mode: 'single',
      fixed,
      items: ['ambient', 'todos'],
      intervalMinutes: 30,
    })
    assert.deepEqual(plan, {
      mode: 'cycle',
      fixed: 'work',
      items: ['work', fixed],
      intervalMinutes: 30,
    })
    assert.deepEqual(normalizeInkPlan(plan), plan)
    assert.deepEqual(
      normalizeShellPreferences({ inkPlan: { mode: 'single', fixed } }).inkPlan.items,
      ['work', fixed],
    )
  }
})
test('shell defaults provide control; malformed routes cannot become file or network destinations', () => {
  assert.deepEqual(normalizeShellPreferences(null), {
    version: 1,
    form: 'standard',
    view: 'control',
    target: 'desktop',
    focusMode: false,
    desktopLayout: 'work',
    inkPlan: DEFAULT_INK_PLAN,
    hudSettings: DEFAULT_HUD_SETTINGS,
  })
  assert.deepEqual(normalizeShellPreferences({ form: 'hud', view: 'https://untrusted/' }), {
    version: 1,
    form: 'standard',
    view: 'control',
    target: 'desktop',
    focusMode: false,
    desktopLayout: 'work',
    inkPlan: DEFAULT_INK_PLAN,
    hudSettings: DEFAULT_HUD_SETTINGS,
  })
  const f = fixture()
  assert.throws(() => f.shell.navigate('../../config'))
  assert.throws(() => f.shell.open('https://untrusted/'))
  assert.throws(() => f.shell.selectForm('screen'))
  assert.equal(f.saved.length, 0)
})
test('legacy form actions open windows without changing the client entry point', () => {
  const f = fixture()
  f.shell.navigate('ambient')
  f.calls.length = 0
  f.shell.selectForm('hud')
  assert.deepEqual(f.calls, ['hud', 'changed'])
  f.calls.length = 0
  f.shell.open('screen')
  assert.deepEqual(f.calls, ['screen', 'changed'])
  assert.equal(f.shell.snapshot().form, 'standard')
  f.calls.length = 0
  f.shell.open('standard', 'usage')
  assert.deepEqual(f.calls, ['changed', 'expand', 'standard', 'changed'])
  assert.equal(f.shell.snapshot().form, 'standard')
  f.calls.length = 0
  f.shell.selectForm('standard')
  assert.deepEqual(f.calls, ['expand', 'standard', 'changed'])
  assert.equal(f.shell.snapshot().view, 'control')
  assert.equal(f.shell.snapshot().hudVisible, true)
})
test('startup and reopen reveal Control even for a legacy HUD-only profile or unwritable store', () => {
  const f = fixture({
    form: 'hud',
    view: 'ambient',
    target: 'ink',
    focusMode: true,
    desktopLayout: 'board',
    hudSettings: { hudOpacity: 37 },
  })
  f.failSave()
  f.shell.restore()
  assert.deepEqual(f.calls, ['expand', 'standard', 'changed'])
  assert.equal(f.shell.snapshot().view, 'control')
  assert.equal(f.shell.snapshot().focusMode, false)
  assert.equal(f.shell.snapshot().target, 'ink')
  assert.equal(f.shell.snapshot().desktopLayout, 'board')
  assert.equal(f.shell.snapshot().hudSettings.hudOpacity, 37)
  f.withoutHud()
  f.calls.length = 0
  f.shell.restore()
  assert.deepEqual(f.calls, ['expand', 'standard', 'changed'])
  assert.throws(() => f.shell.selectForm('hud'))
  assert.equal(f.saved.length, 0)
})
test('selecting the current card neither saves nor broadcasts', () => {
  const f = fixture()
  f.shell.selectTarget('desktop')
  assert.equal(f.saved.length, 0)
  assert.deepEqual(f.calls, [])
})
test('a failed preference write cannot change visible windows or the saved route', () => {
  const f = fixture()
  f.failSave()
  assert.throws(() => f.shell.navigate('work'))
  assert.throws(() => f.shell.setFocusMode(true))
  assert.throws(() => f.shell.selectTarget('ink'))
  assert.throws(() => f.shell.setDesktopLayout('board'))
  assert.deepEqual(f.calls, [])
  assert.equal(f.shell.snapshot().view, 'control')
  assert.equal(f.shell.snapshot().focusMode, false)
})
test('shell persistence is additive and does not rewrite account, device, content or HUD data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codepulse-shell-'))
  try {
    const sentinel = join(directory, 'device-display.json')
    writeFileSync(sentinel, '{"mode":"usage"}')
    const store = shellPreferenceStore(join(directory, 'product-shell.json'))
    store.write(
      normalizeShellPreferences({
        version: 1,
        form: 'hud',
        view: 'screen',
        focusMode: true,
        desktopLayout: 'board',
      }),
    )
    assert.equal(store.read().view, 'control')
    assert.equal(store.read().target, 'ink')
    assert.equal(store.read().focusMode, true)
    assert.equal(store.read().desktopLayout, 'board')
    assert.equal(store.read().form, 'standard')
    assert.equal(readFileSync(sentinel, 'utf8'), '{"mode":"usage"}')
    writeFileSync(join(directory, 'product-shell.json'), 'null')
    assert.equal(store.read().view, 'control')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
test('closing one device view does not stop another view scan or cancel its provisioning', () => {
  const scans: boolean[] = []
  let cancelled = 0
  const lease = new DeviceViewLeases(
    (v) => scans.push(v),
    () => cancelled++,
  )
  lease.start(1)
  lease.start(2)
  lease.stop(1)
  assert.deepEqual(scans, [true])
  assert.equal(lease.claim(2), true)
  assert.equal(lease.claim(1), false)
  assert.equal(lease.cancelFor(1), false)
  lease.release(1)
  assert.equal(cancelled, 0)
  lease.finish(2)
  assert.deepEqual(scans, [true, false, true])
  lease.release(2)
  assert.deepEqual(scans, [true, false, true, false])
})
test('destroying the provisioning owner cancels only its operation and keeps ownership until settled', () => {
  let cancelled = 0
  const lease = new DeviceViewLeases(
    () => {},
    () => cancelled++,
  )
  assert.equal(lease.claim(7), true)
  lease.release(7)
  assert.equal(cancelled, 1)
  assert.equal(lease.claim(8), false)
  lease.finish(7)
  assert.equal(lease.claim(8), true)
})
test('production product IPC validates routes and passes native window changes with sender identity', async () => {
  const f = fixture(),
    handlers = new Map<string, (...args: any[]) => any>()
  let sender = 0
  registerProductIpc(
    {
      handle: (channel, callback) => {
        handlers.set(channel, callback)
      },
    },
    f.shell,
    {
      configure: (id) => {
        sender = id
        return { pinned: false, fullscreen: false }
      },
    },
  )
  assert.throws(() => handlers.get('codepulse:shell-open')!({}, 'file:///secret'))
  handlers.get('codepulse:workbench-configure')!({ sender: { id: 17 } }, { pinned: true })
  assert.equal(sender, 17)
  handlers.get('codepulse:shell-navigate')!({}, 'screen')
  assert.equal(f.shell.snapshot().view, 'control')
  assert.equal(f.shell.snapshot().target, 'ink')
  assert.throws(() => handlers.get('codepulse:shell-target')!({}, 'browser'))
  assert.throws(() => handlers.get('codepulse:shell-focus')!({}, 'true'))
  assert.throws(() => handlers.get('codepulse:shell-desktop-layout')!({}, 'bad'))
  assert.throws(() => handlers.get('codepulse:shell-hud-visible')!({}, 1))
})

test('legacy routes migrate without losing presentation preferences', () => {
  assert.equal(normalizeShellPreferences({ view: 'overview' }).view, 'control')
  const ink = normalizeShellPreferences({ form: 'hud', view: 'screen' })
  assert.equal(ink.view, 'control')
  assert.equal(ink.target, 'ink')
  assert.equal(ink.form, 'standard')
  assert.equal(normalizeShellPreferences({ view: 'ambient', target: 'desktop' }).target, 'ink')
  assert.equal(normalizeShellPreferences({ view: 'usage', target: 'hud' }).target, 'desktop')
  assert.equal(
    normalizeShellPreferences({ focusMode: 'true', desktopLayout: 'invalid' }).focusMode,
    false,
  )
})

test('configuration target selection never opens a window or changes launch preference', () => {
  const f = fixture()
  f.shell.selectTarget('ink')
  assert.deepEqual(f.calls, ['changed'])
  assert.equal(f.shell.snapshot().form, 'standard')
  f.shell.navigate('ambient')
  assert.deepEqual(productTargets('ambient'), ['ink'])
  assert.throws(() => f.shell.selectTarget('desktop'))
  f.shell.navigate('usage')
  assert.deepEqual(productTargets('usage'), ['desktop'])
  assert.equal(f.shell.snapshot().target, 'desktop')
  assert.throws(() => f.shell.selectTarget('hud'))
  f.shell.navigate('settings')
  assert.deepEqual(productTargets('settings'), [])
  assert.throws(() => f.shell.selectTarget('ink'))
})

test('focus mode is reversible and preserves configured layout, target and HUD visibility', () => {
  const f = fixture({ view: 'control', target: 'ink', desktopLayout: 'board' })
  f.shell.setHudVisible(true)
  f.calls.length = 0
  f.shell.setFocusMode(true)
  assert.deepEqual(f.calls, ['changed', 'focus'])
  assert.equal(f.shell.snapshot().focusMode, true)
  f.shell.setFocusMode(false)
  assert.equal(f.shell.snapshot().view, 'control')
  assert.equal(f.shell.snapshot().target, 'ink')
  assert.equal(f.shell.snapshot().desktopLayout, 'board')
  assert.equal(f.shell.snapshot().hudVisible, true)
  assert.equal(f.shell.snapshot().form, 'standard')
  f.shell.setFocusMode(true)
  f.shell.open('standard', 'settings')
  assert.equal(f.shell.snapshot().focusMode, false)
  assert.equal(f.shell.snapshot().view, 'settings')
})

test('HUD visibility is a live state, independent of the saved launch form', () => {
  const f = fixture({ form: 'standard', view: 'control', target: 'ink' })
  f.shell.setHudVisible(true)
  assert.equal(f.shell.snapshot().hudVisible, true)
  f.shell.setHudVisible(false)
  assert.equal(f.shell.snapshot().hudVisible, false)
  assert.equal(f.shell.snapshot().target, 'ink')
  assert.equal(f.shell.snapshot().form, 'standard')
  assert.equal(f.saved.length, 0)
  assert.ok(!f.calls.includes('hide-standard'))
})

test('HUD style settings keep the panel by default and reject unknown values', () => {
  assert.equal(normalizeHudSettings({}).hudStyle, 'panel')
  assert.equal(normalizeHudSettings({}).autoReveal, false)
  assert.equal('orbPosition' in normalizeHudSettings({}), false)
  for (const hudStyle of HUD_SURFACE_STYLES) {
    assert.equal(normalizeHudSettings({ hudStyle }).hudStyle, hudStyle)
  }
  assert.equal(normalizeHudSettings({ hudStyle: 'blimp' }).hudStyle, 'panel')
  assert.equal(normalizeHudSettings({ autoReveal: 'yes' }).autoReveal, false)
  assert.deepEqual(normalizeHudSettings({ orbPosition: { x: 10.4, y: -20.6 } }).orbPosition, {
    x: 10,
    y: -21,
  })
  assert.equal('orbPosition' in normalizeHudSettings({ orbPosition: { x: NaN, y: 1 } }), false)
})
