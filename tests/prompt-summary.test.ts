import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clipChineseSummary,
  isPrimarilyCjk,
  summarizeUserPrompt,
  tokenizeWords,
} from '../packages/core/src/rule-engine/index.js'

test('summarizeUserPrompt keeps short Chinese asks within 15 汉字', () => {
  const body = summarizeUserPrompt('请帮我修复更新超时并优化下载')
  assert.equal(body, '修复更新超时并优化下载')
  assert.equal(countHan(body), 11)
  assert.ok(countHan(body) <= 15)
})

test('summarizeUserPrompt caps long Chinese prompts at 15 汉字', () => {
  const body = summarizeUserPrompt('请帮我修复更新超时并优化下载镜像选择逻辑')
  // 修复更新超时并优化下载镜像选择逻辑 → 17 Han chars → first 15
  assert.equal(body, '修复更新超时并优化下载镜像选择')
  assert.equal(countHan(body), 15)
  assert.doesNotMatch(body, /逻辑/)
})

test('summarizeUserPrompt caps English prompts at 15 complete words', () => {
  const body = summarizeUserPrompt(
    'Please help me fix the update timeout issue and optimize download mirrors carefully for all users across regions today',
  )
  assert.equal(
    body,
    'fix the update timeout issue and optimize download mirrors carefully for all users across regions',
  )
  assert.equal(tokenizeWords(body).length, 15)
  assert.doesNotMatch(body, /today/)
  assert.equal(isPrimarilyCjk(body), false)
})

test('summarizeUserPrompt strips wrappers and code noise', () => {
  const body = summarizeUserPrompt(
    '<user_query>\n帮我 git commit 一下\n```ts\nconst x = 1\n```\n</user_query>',
  )
  assert.match(body, /git commit/)
  assert.doesNotMatch(body, /const|user_query|```/)
})

test('summarizeUserPrompt falls back when prompt is empty', () => {
  assert.equal(summarizeUserPrompt(undefined), '任务完成')
  assert.equal(summarizeUserPrompt('   '), '任务完成')
  assert.equal(summarizeUserPrompt('请帮我'), '任务完成')
})

test('clipChineseSummary counts each 汉字 toward the budget', () => {
  assert.equal(clipChineseSummary('修复更新超时并优化下载', 15), '修复更新超时并优化下载')
  assert.equal(
    clipChineseSummary('修复更新超时并优化下载镜像选择逻辑', 15),
    '修复更新超时并优化下载镜像选择',
  )
  assert.equal(countHan(clipChineseSummary('一二三四五六七八九十一二三四五六', 15)), 15)
})

test('tokenizeWords treats CJK pairs as words and Latin runs as words', () => {
  assert.deepEqual(tokenizeWords('修复更新超时并优化下载'), [
    '修复',
    '更新',
    '超时',
    '并',
    '优化',
    '下载',
  ])
  assert.deepEqual(tokenizeWords('fix update timeout'), ['fix', 'update', 'timeout'])
})

function countHan(text: string): number {
  return [...text].filter((ch) => /[\u3400-\u9fff\uf900-\ufaff]/u.test(ch)).length
}
