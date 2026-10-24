import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalizeShellPreferences, type ShellPreferences } from '@codepulse/shared'
import { ProductShell, shellPreferenceStore } from '../apps/desktop/src/main/product-shell.js'
import { DeviceViewLeases } from '../apps/desktop/src/main/device-view-leases.js'
import { registerProductIpc } from '../apps/desktop/src/main/product-ipc.js'

function fixture(input?: unknown) {
  let hud = true,
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
      standard: () => calls.push('standard'),
      hud: () => calls.push('hud'),
      screen: () => calls.push('screen'),
      hideStandard: () => calls.push('hide-standard'),
      hideHud: () => calls.push('hide-hud'),
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
test('shell defaults provide overview; malformed routes cannot become file or network destinations', () => {
  assert.deepEqual(normalizeShellPreferences(null), {
    version: 1,
    form: 'standard',
    view: 'overview',
  })
  assert.deepEqual(normalizeShellPreferences({ form: 'hud', view: 'https://untrusted/' }), {
    version: 1,
    form: 'hud',
    view: 'overview',
  })
  const f = fixture()
  assert.throws(() => f.shell.navigate('../../config'))
  assert.throws(() => f.shell.open('https://untrusted/'))
  assert.throws(() => f.shell.selectForm('screen'))
  assert.equal(f.saved.length, 0)
})
test('switching main form remembers startup and hides only its peer; screen is independent', () => {
  const f = fixture()
  f.shell.navigate('ambient')
  f.calls.length = 0
  f.shell.selectForm('hud')
  assert.deepEqual(f.calls, ['changed', 'hud', 'hide-standard'])
  f.calls.length = 0
  f.shell.open('screen')
  assert.deepEqual(f.calls, ['screen'])
  assert.equal(f.shell.snapshot().form, 'hud')
  f.calls.length = 0
  f.shell.open('standard', 'usage')
  assert.deepEqual(f.calls, ['changed', 'standard'])
  assert.equal(f.shell.snapshot().form, 'hud')
  f.calls.length = 0
  f.shell.selectForm('standard')
  assert.deepEqual(f.calls, ['changed', 'standard', 'hide-hud'])
  assert.equal(f.shell.snapshot().view, 'usage')
})
test('startup restores exactly one preferred form; unavailable HUD falls back without losing preference', () => {
  const f = fixture({ form: 'hud', view: 'work' })
  f.shell.restore()
  assert.deepEqual(f.calls, ['hud'])
  f.withoutHud()
  f.calls.length = 0
  f.shell.restore()
  assert.deepEqual(f.calls, ['standard'])
  assert.equal(f.shell.snapshot().form, 'hud')
  assert.throws(() => f.shell.selectForm('hud'))
  assert.equal(f.saved.length, 0)
})
test('a failed preference write cannot change visible windows or the saved route', () => {
  const f = fixture()
  f.failSave()
  assert.throws(() => f.shell.selectForm('hud'))
  assert.throws(() => f.shell.navigate('work'))
  assert.deepEqual(f.calls, [])
  assert.equal(f.shell.snapshot().view, 'overview')
})
test('shell persistence is additive and does not rewrite account, device, content or HUD data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codepulse-shell-'))
  try {
    const sentinel = join(directory, 'device-display.json')
    writeFileSync(sentinel, '{"mode":"usage"}')
    const store = shellPreferenceStore(join(directory, 'product-shell.json'))
    store.write({ version: 1, form: 'hud', view: 'screen' })
    assert.equal(store.read().view, 'screen')
    assert.equal(store.read().form, 'hud')
    assert.equal(readFileSync(sentinel, 'utf8'), '{"mode":"usage"}')
    writeFileSync(join(directory, 'product-shell.json'), 'null')
    assert.equal(store.read().view, 'overview')
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
  assert.equal(f.shell.snapshot().view, 'screen')
})
