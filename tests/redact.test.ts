import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MASK, projectLabels, redactSecrets, sessionTitle } from '../apps/desktop/src/renderer/src/lib/redact.js'

const copy = { hidden: '首条提示已隐藏', untitled: '未命名对话' }

test('masks password assignments in quoted and bare forms', () => {
  assert.equal(redactSecrets('连接 server 时 password: "hunter2"'), `连接 server 时 password: ${MASK}`)
  assert.equal(redactSecrets("password='hunter2' next"), `password=${MASK} next`)
  assert.equal(redactSecrets('DB_PASSWORD=abc123 npm start'), `DB_PASSWORD=${MASK} npm start`)
  assert.equal(redactSecrets('{"password": "x y z"}'), `{"password": ${MASK}}`)
})

test('masks token, secret and key assignments', () => {
  assert.equal(redactSecrets('token=abcdef123 and more'), `token=${MASK} and more`)
  assert.equal(redactSecrets('client_secret: s3cr3t!'), `client_secret: ${MASK}`)
  assert.equal(redactSecrets('api_key = "k-12345"'), `api_key = ${MASK}`)
  assert.equal(redactSecrets('OPENAI_API_KEY=abc'), `OPENAI_API_KEY=${MASK}`)
})

test('masks Bearer tokens and Authorization headers', () => {
  assert.equal(redactSecrets('curl -H "Bearer abc.def-123456"'), `curl -H "Bearer ${MASK}"`)
  assert.equal(redactSecrets('Authorization: Bearer abc123xyz'), `Authorization: ${MASK}`)
  assert.equal(redactSecrets('authorization=Basic dXNlcjpwYXNz'), `authorization=${MASK}`)
})

test('masks well-known key shapes', () => {
  assert.equal(redactSecrets('use sk-proj-AbCdEf0123456789 here'), `use ${MASK} here`)
  assert.equal(redactSecrets('ghp_0123456789abcdefABCDEF0123'), MASK)
  assert.equal(redactSecrets('glpat-abcdefghij0123456789'), MASK)
  assert.equal(redactSecrets('id AKIAABCDEFGHIJKLMNOP'), `id ${MASK}`)
  assert.equal(redactSecrets('jwt eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJ'), `jwt ${MASK}`)
  assert.equal(redactSecrets('hash a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8'), `hash ${MASK}`)
})

test('masks URL credentials and Chinese password phrases', () => {
  assert.equal(redactSecrets('git clone https://bob:pw123@host/repo.git'), `git clone https://bob:${MASK}@host/repo.git`)
  assert.equal(redactSecrets('数据库密码是 abc123，别外传'), `数据库密码是 ${MASK}，别外传`)
  assert.equal(redactSecrets('密码：abc123'), `密码：${MASK}`)
})

test('leaves ordinary prompts alone', () => {
  const plain = '修复墨水屏同步失败 in src/main/ink-status.ts, see the Bearer of bad news'
  assert.equal(redactSecrets(plain), plain)
  assert.equal(redactSecrets('The keyboard shortcut is Ctrl+K'), 'The keyboard shortcut is Ctrl+K')
})

test('session titles are hidden by default and masked once revealed', () => {
  assert.equal(sessionTitle('CodePulse', '修复墨水屏同步失败', false, copy), 'CodePulse · 首条提示已隐藏')
  assert.equal(sessionTitle('api-gateway', '连接 server 时 password: "x"', false, copy), 'api-gateway · 首条提示已隐藏')
  assert.equal(sessionTitle('api-gateway', '连接 server 时 password: "x"', true, copy), `api-gateway · 连接 server 时 password: ${MASK}`)
  assert.equal(sessionTitle('p', undefined, false, copy), 'p · 未命名对话')
  assert.equal(sessionTitle('p', '   ', true, copy), 'p · 未命名对话')
})

test('revealed titles are collapsed to one line and capped', () => {
  const long = `line one\n${'a b '.repeat(100)}`
  const shown = sessionTitle('p', long, true, copy)
  assert.ok(!shown.includes('\n'))
  assert.ok(shown.endsWith('…'))
  assert.ok(shown.length <= 'p · '.length + 161)
})

test('duplicate project names get the shortest distinguishing path tail', () => {
  const labels = projectLabels([
    { name: 'CodePulse', path: 'E:/work/CodePulse' },
    { name: 'wt-a', path: 'E:/x/scratchpad/wt-a' },
    { name: 'wt-a', path: 'E:\\x\\tmp\\wt-a' },
  ])
  assert.deepEqual(labels, ['CodePulse', 'wt-a · scratchpad/wt-a', 'wt-a · tmp/wt-a'])
})

test('duplicates that share a parent folder need a longer tail', () => {
  const labels = projectLabels([
    { name: 'app', path: '/a/web/app' },
    { name: 'app', path: '/b/web/app' },
  ])
  assert.deepEqual(labels, ['app · a/web/app', 'app · b/web/app'])
})

test('duplicates with empty paths keep their plain name', () => {
  assert.deepEqual(projectLabels([{ name: 'x', path: '' }, { name: 'x', path: '' }]), ['x', 'x'])
})
