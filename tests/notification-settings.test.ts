import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  readNotificationsEnabled,
  writeNotificationsEnabled,
} from '../apps/desktop/src/main/notification-settings.js'

function tempSettingsPath(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'codepulse-notify-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'notification-settings.json')
}

test('desktop notifications are off when no setting has been saved', (t) => {
  assert.equal(readNotificationsEnabled(tempSettingsPath(t)), false)
})

test('malformed or non-true notification settings stay off', (t) => {
  const path = tempSettingsPath(t)
  for (const content of ['not json', 'null', '{}', '{"enabled":"true"}', '{"enabled":1}']) {
    writeFileSync(path, content, 'utf8')
    assert.equal(readNotificationsEnabled(path), false, content)
  }
})

test('notification opt-in round-trips and only accepts true', (t) => {
  const path = tempSettingsPath(t)

  assert.equal(writeNotificationsEnabled(path, true), true)
  assert.equal(readNotificationsEnabled(path), true)

  assert.equal(writeNotificationsEnabled(path, 'yes'), false)
  assert.equal(readNotificationsEnabled(path), false)
})
