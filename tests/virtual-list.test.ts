import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildVirtualListLayout,
  findVirtualListRange,
} from '../apps/desktop/src/renderer/src/lib/virtualList.js'

test('virtual project layout uses measured heights and stable gaps', () => {
  const layout = buildVirtualListLayout(
    ['a', 'b', 'c'],
    new Map([
      ['a', 100],
      ['c', 80],
    ]),
    50,
    10,
  )

  assert.deepEqual(
    layout.rows.map((row) => ({ key: row.key, start: row.start, end: row.end })),
    [
      { key: 'a', start: 0, end: 100 },
      { key: 'b', start: 110, end: 160 },
      { key: 'c', start: 170, end: 250 },
    ],
  )
  assert.equal(layout.totalSize, 250)
})

test('virtual project range returns only viewport rows plus overscan', () => {
  const keys = Array.from({ length: 20 }, (_, index) => `project-${index}`)
  const layout = buildVirtualListLayout(keys, new Map(), 50, 10)

  assert.deepEqual(findVirtualListRange(layout.rows, 300, 100, 0), { start: 5, end: 7 })
  assert.deepEqual(findVirtualListRange(layout.rows, 300, 100, 60), { start: 4, end: 8 })
})
