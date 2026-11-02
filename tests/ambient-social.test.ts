import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SOCIAL_PAIR_KEY,
  readRememberedSocial,
  socialRowOn,
  toggleSocialRow,
  writeRememberedSocial,
} from '../apps/desktop/src/renderer/src/lib/ambientSocial.js'

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}

test('the row reads on when either rule is on', () => {
  assert.equal(socialRowOn({ xEnabled: false, memeEnabled: true }), true)
  assert.equal(socialRowOn({ xEnabled: true, memeEnabled: false }), true)
  assert.equal(socialRowOn({ xEnabled: false, memeEnabled: false }), false)
})

test('turning the row off remembers the pair and turning it on restores it exactly', () => {
  for (const pair of [
    { xEnabled: false, memeEnabled: true },
    { xEnabled: true, memeEnabled: false },
    { xEnabled: true, memeEnabled: true },
  ]) {
    const off = toggleSocialRow(pair, undefined)
    assert.deepEqual(off.patch, { xEnabled: false, memeEnabled: false })
    assert.deepEqual(off.remembered, pair)
    assert.deepEqual(toggleSocialRow(off.patch, off.remembered).patch, pair)
  }
})

test('with nothing remembered the row turns on meme only, never X', () => {
  const none = { xEnabled: false, memeEnabled: false }
  assert.deepEqual(toggleSocialRow(none, undefined).patch, { xEnabled: false, memeEnabled: true })
  assert.deepEqual(toggleSocialRow(none, none).patch, { xEnabled: false, memeEnabled: true }, 'an all-off memory is not a memory')
})

test('the remembered pair survives a restart through storage', () => {
  const storage = new MemoryStorage()
  const off = toggleSocialRow({ xEnabled: true, memeEnabled: false }, undefined)
  writeRememberedSocial(storage, off.remembered)
  assert.ok(storage.values.has(SOCIAL_PAIR_KEY))
  assert.equal(SOCIAL_PAIR_KEY.startsWith('codepulse:'), true)
  // A new session reads it back and the row restores X-only exactly.
  const restored = readRememberedSocial(storage)
  assert.deepEqual(restored, { xEnabled: true, memeEnabled: false })
  assert.deepEqual(toggleSocialRow({ xEnabled: false, memeEnabled: false }, restored).patch, { xEnabled: true, memeEnabled: false })
  writeRememberedSocial(storage, undefined)
  assert.equal(readRememberedSocial(storage), undefined)
})

test('with no stored memory (even when an X key is saved) the first turn-on is meme only', () => {
  const storage = new MemoryStorage()
  assert.equal(readRememberedSocial(storage), undefined)
  assert.deepEqual(toggleSocialRow({ xEnabled: false, memeEnabled: false }, readRememberedSocial(storage)).patch, {
    xEnabled: false,
    memeEnabled: true,
  })
})

test('malformed or unavailable storage is ignored', () => {
  const storage = new MemoryStorage()
  for (const raw of ['not json', '[]', 'null', '{"xEnabled":true}', '{"xEnabled":"yes","memeEnabled":false}', '42']) {
    storage.setItem(SOCIAL_PAIR_KEY, raw)
    assert.equal(readRememberedSocial(storage), undefined, raw)
  }
  assert.equal(readRememberedSocial(undefined), undefined)
  const broken = {
    getItem() {
      throw new Error('denied')
    },
    setItem() {
      throw new Error('denied')
    },
  }
  assert.equal(readRememberedSocial(broken), undefined)
  assert.doesNotThrow(() => writeRememberedSocial(broken, { xEnabled: true, memeEnabled: true }))
})
