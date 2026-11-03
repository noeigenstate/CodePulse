import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_YUANBAO } from '@codepulse/shared'
import {
  LIFE_TRIPLE_KEY,
  deriveYuanbaoEnabled,
  lifeRowOn,
  parseStocks,
  parseTools,
  readRememberedLife,
  rememberAfterLifeFlag,
  setYuanbaoFlag,
  toggleLifeRow,
  withDerivedEnabled,
  writeRememberedLife,
} from '../apps/desktop/src/renderer/src/lib/yuanbaoRows.js'

const off = {
  ...DEFAULT_YUANBAO,
  weatherEnabled: false,
  goldEnabled: false,
  stocksEnabled: false,
  toolsEnabled: false,
  holidayEnabled: false,
  newsEnabled: false,
}

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

test('enabled is the OR of the six feature flags on every save', () => {
  assert.equal(deriveYuanbaoEnabled(off), false)
  for (const flag of [
    'weatherEnabled',
    'goldEnabled',
    'stocksEnabled',
    'toolsEnabled',
    'holidayEnabled',
    'newsEnabled',
  ] as const) {
    const on = setYuanbaoFlag(off, flag, true)
    assert.equal(on.enabled, true, flag)
    assert.equal(setYuanbaoFlag(on, flag, false).enabled, false, flag + ' off again')
  }
  assert.equal(
    withDerivedEnabled({ ...off, enabled: true }).enabled,
    false,
    'a stale true is corrected',
  )
  assert.equal(
    withDerivedEnabled({ ...off, newsEnabled: true, enabled: false }).enabled,
    true,
    'a stale false is corrected',
  )
  const twoOn = setYuanbaoFlag(setYuanbaoFlag(off, 'toolsEnabled', true), 'newsEnabled', true)
  assert.equal(
    setYuanbaoFlag(twoOn, 'toolsEnabled', false).enabled,
    true,
    'one feature still on keeps it enabled',
  )
})

test('the 生活卡 row restores exactly the remembered triple and never enables a sub-feature that was off', () => {
  const goldOnly = { weatherEnabled: false, goldEnabled: true, stocksEnabled: false }
  const offTriple = toggleLifeRow(goldOnly, undefined)
  assert.deepEqual(offTriple.patch, {
    weatherEnabled: false,
    goldEnabled: false,
    stocksEnabled: false,
  })
  assert.deepEqual(offTriple.remembered, goldOnly)
  assert.deepEqual(toggleLifeRow(offTriple.patch, offTriple.remembered).patch, goldOnly)
  const weatherStocks = { weatherEnabled: true, goldEnabled: false, stocksEnabled: true }
  const again = toggleLifeRow(weatherStocks, undefined)
  assert.deepEqual(toggleLifeRow(again.patch, again.remembered).patch, weatherStocks)
})

test('with nothing remembered the row turns on weather only', () => {
  const none = { weatherEnabled: false, goldEnabled: false, stocksEnabled: false }
  assert.deepEqual(toggleLifeRow(none, undefined).patch, {
    weatherEnabled: true,
    goldEnabled: false,
    stocksEnabled: false,
  })
  assert.deepEqual(
    toggleLifeRow(none, none).patch,
    { weatherEnabled: true, goldEnabled: false, stocksEnabled: false },
    'an all-off memory is not a memory',
  )
  assert.equal(lifeRowOn({ weatherEnabled: false, goldEnabled: false, stocksEnabled: true }), true)
})

test('an individual toggle replaces the memory, and all-off forgets it', () => {
  const triple = { weatherEnabled: true, goldEnabled: true, stocksEnabled: false }
  assert.deepEqual(rememberAfterLifeFlag(triple, 'goldEnabled', false), {
    weatherEnabled: true,
    goldEnabled: false,
    stocksEnabled: false,
  })
  assert.deepEqual(rememberAfterLifeFlag(triple, 'stocksEnabled', true), {
    weatherEnabled: true,
    goldEnabled: true,
    stocksEnabled: true,
  })
  assert.equal(
    rememberAfterLifeFlag(
      { weatherEnabled: true, goldEnabled: false, stocksEnabled: false },
      'weatherEnabled',
      false,
    ),
    undefined,
  )
})

test('the remembered triple persists across restarts and ignores malformed storage', () => {
  const storage = new MemoryStorage()
  const goldStocks = { weatherEnabled: false, goldEnabled: true, stocksEnabled: true }
  writeRememberedLife(storage, goldStocks)
  assert.ok(LIFE_TRIPLE_KEY.startsWith('codepulse:'))
  assert.deepEqual(readRememberedLife(storage), goldStocks)
  writeRememberedLife(storage, undefined)
  assert.equal(readRememberedLife(storage), undefined)
  for (const raw of [
    'nope',
    '[]',
    'null',
    '{"weatherEnabled":true}',
    '{"weatherEnabled":1,"goldEnabled":true,"stocksEnabled":true}',
  ]) {
    storage.setItem(LIFE_TRIPLE_KEY, raw)
    assert.equal(readRememberedLife(storage), undefined, raw)
  }
  assert.equal(readRememberedLife(undefined), undefined)
  const broken = {
    getItem() {
      throw new Error('denied')
    },
    setItem() {
      throw new Error('denied')
    },
  }
  assert.equal(readRememberedLife(broken), undefined)
  assert.doesNotThrow(() => writeRememberedLife(broken, goldStocks))
})

test('stocks accept up to three <code>.<market> symbols and report the format otherwise', () => {
  assert.deepEqual(parseStocks('00700.hk, 600519.SH aapl.us'), {
    ok: true,
    stocks: ['00700.hk', '600519.sh', 'aapl.us'],
  })
  assert.deepEqual(parseStocks(''), { ok: true, stocks: [] })
  assert.deepEqual(parseStocks('00700.hk，00700.hk'), { ok: true, stocks: ['00700.hk'] })
  assert.deepEqual(parseStocks('00700'), { ok: false, error: '格式：00700.hk' })
  assert.deepEqual(parseStocks('00700.hk, tsla'), { ok: false, error: '格式：00700.hk' })
  assert.deepEqual(parseStocks('a.hk b.hk c.hk d.hk'), { ok: false, error: '最多 3 个' })
})

test('tool names are trimmed, de-duplicated and capped at four', () => {
  assert.deepEqual(parseTools('Claude Code,  Codex\nClaude Code'), ['Claude Code', 'Codex'])
  assert.deepEqual(parseTools('a,b,c,d,e'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(parseTools(' , '), [])
  assert.equal(parseTools('x'.repeat(60))[0]!.length, 40)
})
