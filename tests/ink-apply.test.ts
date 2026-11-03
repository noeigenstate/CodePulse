import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import {
  DEFAULT_DEVICE_DISPLAY,
  DEFAULT_INK_PLAN,
  type DeviceDisplayConfig,
} from '@codepulse/shared'
import { toDeviceStatusV1, StatusHub } from '@codepulse/core'
import { ProductShell, shellPreferenceStore } from '../apps/desktop/src/main/product-shell.js'
import { AmbientService } from '../apps/desktop/src/main/ambient-service.js'
import { applyInk, endInkTemporary } from '../apps/desktop/src/main/ink-apply.js'
import {
  readDeviceDisplayConfig,
  writeDeviceDisplayConfig,
} from '../apps/desktop/src/main/device-display-settings.js'

function fixture() {
  const root = resolve('.tmpshots/ia-core-tests')
  mkdirSync(root, { recursive: true })
  const directory = mkdtempSync(join(root, 'apply-')),
    path = join(directory, 'device.json')
  const store = shellPreferenceStore(join(directory, 'shell.json'))
  let notifications = 0,
    ambientWrites = 0,
    failAmbient = false
  const shell = new ProductShell(
    undefined,
    store.write,
    {
      hudAvailable: () => false,
      standard() {},
      hud() {},
      screen() {},
      hideStandard() {},
      hideHud() {},
    },
    () => notifications++,
  )
  shell.setInkPlan(DEFAULT_INK_PLAN)
  writeDeviceDisplayConfig(path, DEFAULT_DEVICE_DISPLAY)
  const ambient = new AmbientService({
    config: { enabled: false, displayMinutes: 10 },
    status: () => new StatusHub().snapshot(),
    key: () => '',
    save: () => {
      if (failAmbient) throw new Error('ambient disk')
      ambientWrites++
    },
    changed: () => notifications++,
    request: async () => ({}),
    image: async () => '',
  })
  notifications = 0
  const deps = {
    shell,
    ambient,
    readDisplay: () => readDeviceDisplayConfig(path),
    writeDisplay: (display: DeviceDisplayConfig) => writeDeviceDisplayConfig(path, display),
    displaySnapshot: () => ({
      config: readDeviceDisplayConfig(path),
      status: toDeviceStatusV1(new StatusHub().snapshot()),
      serverAvailable: false,
    }),
    committed: () => notifications++,
  }
  return {
    deps,
    directory,
    path,
    store,
    notifications: () => notifications,
    ambientWrites: () => ambientWrites,
    failAmbient: () => {
      failAmbient = true
    },
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  }
}
const request = {
  plan: { ...DEFAULT_INK_PLAN, intervalMinutes: 5 as const },
  display: { ...DEFAULT_DEVICE_DISPLAY, inverted: true },
}
test('applyInk rolls back the persisted shell when the display write fails, without publishing memory', () => {
  const f = fixture()
  try {
    const oldShell = f.deps.shell.snapshot(),
      oldConfig = f.deps.ambient.getConfig()
    const disk = readFileSync(join(f.directory, 'shell.json'), 'utf8')
    assert.throws(
      () =>
        applyInk(request, {
          ...f.deps,
          writeDisplay: () => {
            throw new Error('display disk')
          },
        }),
      /display disk/,
    )
    assert.deepEqual(f.deps.shell.snapshot(), oldShell)
    assert.equal(readFileSync(join(f.directory, 'shell.json'), 'utf8'), disk)
    assert.deepEqual(f.deps.ambient.getConfig(), oldConfig)
    assert.equal(readDeviceDisplayConfig(f.path).inverted, false)
    assert.equal(f.ambientWrites(), 0)
    assert.equal(f.notifications(), 0)
  } finally {
    f.dispose()
  }
})
test('an ambient write failure restores the already-saved display and plan', () => {
  const f = fixture()
  try {
    f.failAmbient()
    assert.throws(() => applyInk(request, f.deps), /ambient disk/)
    assert.equal(f.store.read().inkPlan.intervalMinutes, 15)
    assert.equal(readDeviceDisplayConfig(f.path).inverted, false)
    assert.equal(f.deps.shell.snapshot().inkPlan.intervalMinutes, 15)
    assert.equal(f.notifications(), 0)
  } finally {
    f.dispose()
  }
})
test('applyInk validates both parts before any writes and publishes one complete state', () => {
  const f = fixture()
  try {
    assert.throws(
      () => applyInk({ ...request, display: { ...request.display, agents: ['unknown'] } }, f.deps),
      /画面配置/,
    )
    assert.throws(
      () => applyInk({ ...request, plan: { ...request.plan, intervalMinutes: 7 } }, f.deps),
      /节目单/,
    )
    assert.equal(f.notifications(), 0)
    assert.equal(f.ambientWrites(), 0)
    const result = applyInk(request, f.deps)
    assert.equal(result.shell.inkPlan.intervalMinutes, 5)
    assert.equal(result.display.config.inverted, true)
    assert.equal(f.deps.ambient.getConfig().enabled, true)
    assert.equal(f.deps.ambient.getConfig().displayMinutes, 5)
    assert.equal(f.notifications(), 1)
    applyInk({ ...request, plan: { ...request.plan, mode: 'single' } }, f.deps)
    assert.equal(f.deps.ambient.getConfig().enabled, false)
  } finally {
    f.dispose()
  }
})
test('ending both temporary displays leaves the applied playlist unchanged', () => {
  const f = fixture()
  try {
    const card = f.deps.ambient.addPersonal('note', '临时内容')
    f.deps.ambient.showManual(card.id)
    let assistantUntil = 600000
    const before = f.deps.shell.snapshot().inkPlan
    endInkTemporary(f.deps.ambient, {
      clearTemporaryInk: () => {
        assistantUntil = 0
      },
    })
    assert.equal(f.deps.ambient.temporaryInk(), null)
    assert.equal(assistantUntil, 0)
    assert.deepEqual(f.deps.shell.snapshot().inkPlan, before)
  } finally {
    f.dispose()
  }
})
