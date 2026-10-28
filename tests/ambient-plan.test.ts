import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_INK_PLAN } from '@codepulse/shared'
import { inkAllowsAmbient } from '../apps/desktop/src/main/ambient-plan.js'
import { collectNews } from '../apps/desktop/src/main/ambient-sources.js'
test('fixed plans and bounded cycle slots select the intended content', () => {
  assert.equal(inkAllowsAmbient({ ...DEFAULT_INK_PLAN, mode: 'single', fixed: 'work' }, 0), false)
  assert.equal(inkAllowsAmbient({ ...DEFAULT_INK_PLAN, mode: 'single', fixed: 'ambient' }, 0), true)
  assert.equal(inkAllowsAmbient(DEFAULT_INK_PLAN, 0), false)
  assert.equal(inkAllowsAmbient(DEFAULT_INK_PLAN, 15 * 60000), true)
  assert.equal(inkAllowsAmbient(DEFAULT_INK_PLAN, 30 * 60000), false)
})
test('tech source requests a bounded high-signal front page and uses a safe source link', async () => {
  const now = Date.now()
  const cards = await collectNews(now, async (url) => {
    const u = new URL(url)
    assert.equal(u.hostname, 'hn.algolia.com')
    assert.equal(u.searchParams.get('hitsPerPage'), '12')
    assert.match(u.searchParams.get('numericFilters')!, /points>=100/)
    return {
      hits: [
        {
          objectID: '123',
          title: 'A new discovery',
          points: 200,
          created_at_i: Math.floor(now / 1000),
          url: 'javascript:evil()',
        },
        { objectID: 'bad', title: 'bad', points: 500, created_at_i: Math.floor(now / 1000) },
      ],
    }
  })
  assert.equal(cards.length, 1)
  assert.equal(cards[0]!.url, 'https://news.ycombinator.com/item?id=123')
})
