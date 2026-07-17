import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FocusSyncScheduler } from '../apps/desktop/src/main/focus-sync.js'

test('FocusSyncScheduler coalesces bursty focus requests into one scan', async () => {
  let scans = 0
  const scheduler = new FocusSyncScheduler(async () => {
    scans += 1
  }, 5)

  try {
    await Promise.all([scheduler.schedule(), scheduler.schedule(), scheduler.schedule()])
    assert.equal(scans, 1)
  } finally {
    scheduler.cancel()
  }
})

test('FocusSyncScheduler schedules one trailing scan for focus during an active scan', async () => {
  let scans = 0
  let releaseFirst!: () => void
  let signalFirstStarted!: () => void
  const firstStarted = new Promise<void>((resolve) => {
    signalFirstStarted = resolve
  })
  const firstFinished = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const scheduler = new FocusSyncScheduler(async () => {
    scans += 1
    if (scans === 1) {
      signalFirstStarted()
      await firstFinished
    }
  }, 1)

  try {
    const first = scheduler.schedule()
    await firstStarted
    const trailing = scheduler.schedule()
    releaseFirst()
    await Promise.all([first, trailing])
    assert.equal(scans, 2)
  } finally {
    scheduler.cancel()
  }
})

test('FocusSyncScheduler returns scan failures to awaiting callers', async () => {
  const failure = new Error('disk unavailable')
  const scheduler = new FocusSyncScheduler(async () => {
    throw failure
  }, 1)

  try {
    await assert.rejects(scheduler.schedule(), failure)
  } finally {
    scheduler.cancel()
  }
})

test('FocusSyncScheduler cancels a queued scan without running it during shutdown', async () => {
  let scans = 0
  const scheduler = new FocusSyncScheduler(async () => {
    scans += 1
  }, 20)

  const pending = scheduler.schedule()
  scheduler.cancel()
  await pending
  await new Promise<void>((resolve) => setTimeout(resolve, 30))

  assert.equal(scans, 0)
})
