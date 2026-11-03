import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { AmbientCard } from '@codepulse/shared'
import {
  categoryProblem,
  isSourceProblem,
  refreshSummary,
} from '../apps/desktop/src/renderer/src/lib/ambientStatus.js'

// Every status wording the service can put in sourceStatus today.
const NEUTRAL = [
  '已关闭',
  '尚未检查',
  '找到 3 条候选',
  '本轮没有合适内容',
  '已准备 2 张图片',
  '离线可用',
]
const PROBLEMS = [
  '待配置 API 密钥',
  '今日 X 检查已达上限',
  '本地记录无法保存，已暂停付费检查',
  '图片读取失败，稍后重试',
  '连接失败，稍后自动重试',
  '访问被拒绝，请检查凭据与权限',
  '来源限流，稍后自动重试',
  '来源暂不可用 (503)',
  '数据源返回格式异常',
  'X 返回错误，请检查权限或余额',
  'meme 来源暂时不可用',
  '来源未返回内容',
  '来源内容过大',
]

test('neutral source states are not problems and every real error wording is', () => {
  for (const text of NEUTRAL) assert.equal(isSourceProblem(text), false, text)
  for (const text of PROBLEMS) assert.equal(isSourceProblem(text), true, text)
  assert.equal(isSourceProblem(''), false)
  assert.equal(isSourceProblem(undefined), false)
})

test('the classifier knows every error string the main process can throw or store', () => {
  const sources = readFileSync('apps/desktop/src/main/ambient-sources.ts', 'utf8')
  const thrown = [...sources.matchAll(/new Error\(\s*'([^']+)'/g)].map((m) => m[1]!)
  assert.ok(thrown.length >= 5, 'found the thrown messages')
  for (const message of thrown) assert.equal(isSourceProblem(message), true, message)
  for (const status of [
    '访问被拒绝，请检查凭据与权限',
    '来源限流，稍后自动重试',
    '来源暂不可用 (429)',
  ]) {
    assert.ok(sources.includes(status.split(' (')[0]!.split('，')[0]!), status)
  }
  const service = readFileSync('apps/desktop/src/main/ambient-service.ts', 'utf8')
  const stored = [
    ...service.matchAll(/this\.errors(?:\.\w+|\[source\])\s*=\s*\n?\s*(?:`|')([^`']+)(?:`|')/g),
  ].map((m) => m[1]!)
  for (const text of stored) {
    const sample = text.replace(/\$\{[^}]+\}/g, '2')
    assert.equal(
      isSourceProblem(sample),
      !NEUTRAL.some((n) => sample.startsWith(n.slice(0, 2))),
      sample,
    )
  }
})

test('a category shows only its own enabled source error', () => {
  const status = { x: '访问被拒绝，请检查凭据与权限', meme: '已关闭', news: '来源暂不可用 (503)' }
  const on = { x: true, meme: false, news: true }
  assert.equal(categoryProblem('social', status, on), '访问被拒绝，请检查凭据与权限')
  assert.equal(categoryProblem('news', status, on), '来源暂不可用 (503)')
  assert.equal(categoryProblem('social', status, { ...on, x: false }), '')
  assert.equal(categoryProblem('news', status, { ...on, news: false }), '')
  assert.equal(categoryProblem('concept', status, on), '')
  assert.equal(
    categoryProblem(
      'social',
      { x: '待配置 API 密钥', meme: '图片读取失败，稍后重试' },
      { x: false, meme: true, news: false },
    ),
    '图片读取失败，稍后重试',
  )
  assert.equal(categoryProblem('social', undefined, on), '')
})

const card = (id: string, kind: AmbientCard['kind']): AmbientCard => ({ id, kind }) as AmbientCard

test('manual check result: new cards of the category, none, and the error appended', () => {
  const before = new Set(['x1', 'n1'])
  const after = [
    card('x1', 'x'),
    card('x2', 'x'),
    card('m1', 'meme'),
    card('n1', 'news'),
    card('c9', 'concept'),
  ]
  assert.equal(refreshSummary('social', before, after, ''), '找到 2 条新内容')
  assert.equal(refreshSummary('news', before, after, ''), '没有新内容')
  assert.equal(
    refreshSummary('social', new Set(after.map((c) => c.id)), after, '来源限流，稍后自动重试'),
    '没有新内容；来源限流，稍后自动重试',
  )
})

test('every card kind maps to its own category row, 元宝搜索 cards by topic', async () => {
  const { cardCategory } = await import('../apps/desktop/src/renderer/src/lib/ambientStatus.js')
  const of = (kind: AmbientCard['kind'], topic?: AmbientCard['topic']) =>
    cardCategory({ kind, topic })
  assert.deepEqual(
    ['concept', 'prompt', 'pet', 'calendar', 'news'].map((kind) => of(kind as AmbientCard['kind'])),
    ['concept', 'prompt', 'pet', 'calendar', 'news'],
  )
  assert.deepEqual(
    [of('x'), of('meme'), of('image'), of('note')],
    ['social', 'social', 'local', 'local'],
  )
  assert.equal(of('life', 'weather'), 'life')
  assert.deepEqual(
    [of('search', 'tools'), of('search', 'holiday'), of('search', 'news'), of('search')],
    ['tools', 'holiday', 'headlines', undefined],
  )
})

test('a manual check of a 元宝搜索 category counts only that topic', () => {
  const life = { id: 'l1', kind: 'life', topic: 'weather' } as AmbientCard
  const tools = { id: 't1', kind: 'search', topic: 'tools' } as AmbientCard
  const headline = { id: 'h1', kind: 'search', topic: 'news' } as AmbientCard
  assert.equal(refreshSummary('tools', new Set(), [life, tools, headline], ''), '找到 1 条新内容')
  assert.equal(
    refreshSummary('headlines', new Set(['h1']), [life, tools, headline], ''),
    '没有新内容',
  )
  assert.equal(
    refreshSummary('life', new Set(), [life, tools], '密钥错误'),
    '找到 1 条新内容；密钥错误',
  )
})
