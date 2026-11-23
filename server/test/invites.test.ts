import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../src/db.js'
import { inviteHash } from '../src/invites.js'
import { INITIAL, administrator, call, developer, fixture, inviteCode } from './helpers.js'

const register = (invite: unknown, email = 'new@example.com') => ({
  email,
  password: 'password123',
  name: '新开发者',
  invite,
})

test('注册必须使用有效邀请码；一码一号，大小写和短横线不影响', async (t) => {
  const { app } = fixture(t)
  const url = '/api/v1/dev/register'
  assert.equal((await call(app, 'POST', url, register(undefined))).status, 422)
  const bogus = await call(app, 'POST', url, register('CP-AAAA-BBBB-CCCC'))
  assert.equal(bogus.status, 403)
  assert.equal(bogus.body.error, '邀请码无效、已使用或已过期')

  const code = inviteCode(app)
  assert.match(code, /^CP-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
  const typed = ` ${code.toLowerCase().replace(/-/g, '')} `
  const ok = await call(app, 'POST', url, register(typed))
  assert.equal(ok.status, 200)
  assert.equal(ok.body.developer.admin, false)
  assert.equal((await call(app, 'POST', url, register(code, 'second@example.com'))).status, 403)

  // An address already taken is reported before the code is spent.
  const spare = inviteCode(app)
  assert.equal((await call(app, 'POST', url, register(spare))).status, 409)
  assert.equal((await call(app, 'POST', url, register(spare, 'third@example.com'))).status, 200)
})

test('同一邀请码并发注册只有一个成功，失败的不留下账号', async (t) => {
  const { app, dbPath } = fixture(t)
  const code = inviteCode(app)
  const results = await Promise.all(
    ['a@example.com', 'b@example.com', 'c@example.com'].map((email) =>
      call(app, 'POST', '/api/v1/dev/register', register(code, email)),
    ),
  )
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 403, 403])
  const db = openDatabase(dbPath)
  try {
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM developers WHERE email LIKE '%@example.com'")
          .get() as {
          n: number
        }
      ).n,
      1,
    )
  } finally {
    db.close()
  }
})

test('管理员生成、查看和撤销邀请码；只存哈希，过期和撤销的码不能注册', async (t) => {
  const { app, dbPath, advance } = fixture(t)
  const plain = await developer(app, 'plain@example.com')
  for (const [method, url] of [
    ['GET', '/api/v1/admin/invites'],
    ['POST', '/api/v1/admin/invites'],
    ['DELETE', '/api/v1/admin/invites/x'],
  ] as const)
    assert.equal(
      (await call(app, method, url, method === 'GET' ? undefined : {}, plain)).status,
      403,
    )

  const admin = await administrator(app)
  for (const days of [0, 91, 1.5, '7'])
    assert.equal((await call(app, 'POST', '/api/v1/admin/invites', { days }, admin)).status, 422)
  const short = await call(app, 'POST', '/api/v1/admin/invites', { days: 1, note: '朋友 A' }, admin)
  assert.equal(short.status, 200)
  assert.equal(short.body.invite.state, 'unused')
  assert.equal(short.body.invite.note, '朋友 A')
  assert.equal(short.body.invite.expiresAt, INITIAL + 86400000)
  const revoked = await call(app, 'POST', '/api/v1/admin/invites', {}, admin)
  assert.equal(revoked.body.invite.expiresAt, INITIAL + 14 * 86400000)
  const used = await call(app, 'POST', '/api/v1/admin/invites', {}, admin)

  const db = openDatabase(dbPath)
  try {
    const stored = db.prepare('SELECT code_hash FROM invites').all() as { code_hash: string }[]
    assert.ok(stored.some((row) => row.code_hash === inviteHash(used.body.code)))
    assert.ok(!stored.some((row) => row.code_hash.includes(used.body.code)))
  } finally {
    db.close()
  }

  const registered = await call(
    app,
    'POST',
    '/api/v1/dev/register',
    register(used.body.code, 'invited@example.com'),
  )
  assert.equal(registered.status, 200)
  assert.equal(
    (await call(app, 'DELETE', `/api/v1/admin/invites/${used.body.invite.id}`, {}, admin)).status,
    409,
  )
  assert.equal(
    (await call(app, 'DELETE', `/api/v1/admin/invites/${revoked.body.invite.id}`, {}, admin))
      .status,
    200,
  )
  assert.equal((await call(app, 'DELETE', '/api/v1/admin/invites/missing', {}, admin)).status, 404)
  assert.equal(
    (await call(app, 'POST', '/api/v1/dev/register', register(revoked.body.code, 'r@example.com')))
      .status,
    403,
  )
  advance(86400000)
  assert.equal(
    (await call(app, 'POST', '/api/v1/dev/register', register(short.body.code, 's@example.com')))
      .status,
    403,
  )

  const list = await call(app, 'GET', '/api/v1/admin/invites', undefined, admin)
  const state = (id: string) => list.body.invites.find((i: { id: string }) => i.id === id)
  assert.equal(state(short.body.invite.id).state, 'expired')
  assert.equal(state(revoked.body.invite.id).state, 'revoked')
  assert.deepEqual(state(used.body.invite.id).usedBy, {
    email: 'invited@example.com',
    name: '新开发者',
  })
  assert.equal(state(used.body.invite.id).state, 'used')
  assert.equal(state(used.body.invite.id).createdBy, '测试开发者')
  assert.ok(list.body.invites.every((invite: object) => !('code' in invite)))
})

test('invite 命令生成可用邀请码，参数错误时给出用法且不启动服务', async (t) => {
  const { app, dbPath } = fixture(t)
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), 'main-cli.js')
  const env = { ...process.env, CODEPULSE_PLATFORM_DB: dbPath, CODEPULSE_PLATFORM_PORT: 'bad' }
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, 'invite', ...args], { env, encoding: 'utf8', timeout: 5000 })
  const issued = run('--days=3', '第一位', '开发者')
  assert.equal(issued.status, 0, issued.stderr)
  assert.doesNotMatch(issued.stdout, /插件平台：/)
  const code = /邀请码：(CP-[A-Z0-9-]+)/.exec(issued.stdout)?.[1]
  assert.ok(code, issued.stdout)
  const db = openDatabase(dbPath)
  try {
    const row = db.prepare('SELECT note, expires_at - created_at AS span FROM invites').get() as {
      note: string
      span: number
    }
    assert.deepEqual(row, { note: '第一位 开发者', span: 3 * 86400000 })
  } finally {
    db.close()
  }
  assert.equal(
    (await call(app, 'POST', '/api/v1/dev/register', register(code, 'first@example.com'))).status,
    200,
  )
  for (const args of [['--days=0'], ['--days=abc'], ['--days=200'], ['x'.repeat(41)]]) {
    const bad = run(...args)
    assert.equal(bad.status, 1, args.join(' '))
  }
  assert.match(run('--days=abc').stderr, /用法/)
})
