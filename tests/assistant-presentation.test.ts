import test from 'node:test'
import assert from 'node:assert/strict'
import type { AmbientCard } from '@codepulse/shared'
import { selectDeskContent } from '../apps/desktop/src/main/assistant-presentation.js'

function card(id: string, manual?: true): AmbientCard & { manual?: true } {
  return {
    id,
    kind: 'note',
    source: '合成测试',
    text: id,
    url: '',
    publishedAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    score: 0,
    ...(manual ? { manual } : {}),
  }
}
test('explicit image still replaces an automatic todo page, then returns to the configured page', () => {
  const todos = card('todos'),
    image = card('image', true),
    automatic = card('news')
  assert.equal(selectDeskContent(todos, image), image)
  assert.equal(selectDeskContent(todos, automatic), todos)
  assert.equal(selectDeskContent(undefined, automatic), automatic)
})
