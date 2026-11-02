import assert from 'node:assert/strict'
import { test } from 'node:test'
import { socialRowOn, toggleSocialRow } from '../apps/desktop/src/renderer/src/lib/ambientSocial.js'

test('the row reads on when either rule is on', () => {
  assert.equal(socialRowOn({ xEnabled: false, memeEnabled: true }), true)
  assert.equal(socialRowOn({ xEnabled: true, memeEnabled: false }), true)
  assert.equal(socialRowOn({ xEnabled: false, memeEnabled: false }), false)
})

test('turning the row off remembers the pair and turning it on restores meme-only without X', () => {
  const memeOnly = { xEnabled: false, memeEnabled: true }
  const off = toggleSocialRow(memeOnly, undefined, true)
  assert.deepEqual(off.patch, { xEnabled: false, memeEnabled: false })
  assert.deepEqual(off.remembered, memeOnly)
  const on = toggleSocialRow(off.patch, off.remembered, true)
  assert.deepEqual(on.patch, memeOnly, 'X stays off even though a key is saved')
})

test('the remembered pair also restores X-only and both', () => {
  for (const pair of [{ xEnabled: true, memeEnabled: false }, { xEnabled: true, memeEnabled: true }]) {
    const off = toggleSocialRow(pair, undefined, false)
    assert.deepEqual(toggleSocialRow(off.patch, off.remembered, false).patch, pair)
  }
})

test('with nothing remembered it turns on meme, and X only when a key is saved', () => {
  const none = { xEnabled: false, memeEnabled: false }
  assert.deepEqual(toggleSocialRow(none, undefined, false).patch, { xEnabled: false, memeEnabled: true })
  assert.deepEqual(toggleSocialRow(none, undefined, true).patch, { xEnabled: true, memeEnabled: true })
  assert.deepEqual(toggleSocialRow(none, none, false).patch, { xEnabled: false, memeEnabled: true }, 'an all-off memory is not a memory')
})
