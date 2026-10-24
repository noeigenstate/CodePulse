import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Fastify from 'fastify'
import { normalizeEvent, StatusHub, toDeviceStatusV1 } from '@codepulse/core'
import { fromCodexHook } from '@codepulse/adapters'
import { normalizeDeviceDisplay } from '@codepulse/shared'
import { CodexApprovalContext } from '../packages/local-server/src/codex-approval-context.js'
import { registerEventRoutes } from '../packages/local-server/src/routes/events.js'

const jsonl = (row: unknown) => JSON.stringify(row) + '\n'
const context = (
  reviewer: string | undefined,
  turn = 'turn-1',
  policy: unknown = 'on-request',
) => ({
  type: 'turn_context',
  payload: { turn_id: turn, approval_policy: policy, approvals_reviewer: reviewer },
})
function hook(path: string, name = 'PermissionRequest', extra = {}) {
  return {
    source: 'codex',
    hook_event_name: name,
    session_id: 'session-1',
    turn_id: 'turn-1',
    cwd: '/test/codepulse',
    transcript_path: path,
    tool_name: 'Bash',
    ...extra,
  }
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-approval-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'sessions'))
  const path = join(home, 'sessions', 'rollout.jsonl')
  await writeFile(
    path,
    jsonl({ type: 'session_meta', payload: { id: 'session-1' } }) + jsonl(context('auto_review')),
  )
  const reader = new CodexApprovalContext(home)
  const check = (extra = {}) =>
    reader.isAutomaticSandboxApproval(
      normalizeEvent(fromCodexHook(hook(path, 'PermissionRequest', extra))!),
    )
  return { home, path, reader, check }
}

test('auto-reviewed sandbox request is acknowledged without changing shared activity or notifying', async (t) => {
  const { home, path } = await fixture(t)
  const app = Fastify(),
    hub = new StatusHub()
  t.after(() => app.close())
  registerEventRoutes(app, hub, { codexHome: home })
  const post = (name: string, extra = {}) =>
    app.inject({ method: 'POST', url: '/api/events', payload: hook(path, name, extra) })
  await post('UserPromptSubmit')
  await post('PreToolUse')
  const before = hub.snapshot()
  let notifications = 0,
    events = 0
  hub.on('notification', () => notifications++)
  hub.on('event', () => events++)
  // HTTP metadata cannot override native routing; default permission_mode is
  // compatible with both user review and automatic review.
  const response = await post('PermissionRequest', { permission_mode: 'default' })
  assert.equal(response.statusCode, 202)
  assert.equal(response.json().accepted, 1)
  assert.deepEqual(hub.snapshot().agents, before.agents)
  assert.equal(events, 0)
  assert.equal(notifications, 0)
  assert.deepEqual(
    toDeviceStatusV1(hub.snapshot(), normalizeDeviceDisplay({})).threads,
    toDeviceStatusV1(before, normalizeDeviceDisplay({})).threads,
  )
  await post('PostToolUse')
  assert.equal(hub.snapshot().agents[0]!.state, 'THINKING')
  assert.equal(hub.snapshot().agents[0]!.needPermission, false)
})

test('manual mode still raises immediate attention, regardless of untrusted hook fields', async (t) => {
  const { home, path } = await fixture(t)
  await appendFile(path, jsonl(context('user')))
  const app = Fastify(),
    hub = new StatusHub()
  t.after(() => app.close())
  registerEventRoutes(app, hub, { codexHome: home })
  const result = await app.inject({
    method: 'POST',
    url: '/api/events',
    payload: hook(path, 'PermissionRequest', {
      permission_mode: 'bypassPermissions',
      approvals_reviewer: 'auto_review',
    }),
  })
  assert.equal(result.statusCode, 202)
  assert.equal(hub.snapshot().agents[0]!.state, 'WAITING_PERMISSION')
  assert.equal(hub.snapshot().agents[0]!.needPermission, true)
})

test('reviewer is scoped to exact session and latest turn; mode changes do not reuse cached decisions', async (t) => {
  const { path, check } = await fixture(t)
  assert.equal(await check(), true)
  assert.equal(await check({ session_id: 'another-session' }), false)
  assert.equal(await check({ turn_id: 'another-turn' }), false)
  assert.equal(await check({ turn_id: undefined }), false)
  await appendFile(path, jsonl(context('user')))
  assert.equal(await check(), false)
  await appendFile(path, jsonl(context('auto_review', 'turn-2')))
  assert.equal(await check(), false)
  assert.equal(await check({ turn_id: 'turn-2' }), true)
  await appendFile(path, jsonl(context(undefined, 'turn-2')))
  assert.equal(await check({ turn_id: 'turn-2' }), false)
})

test('unknown tools, app approvals, input and noninteractive/unknown policies are not suppressed', async (t) => {
  const { path, check } = await fixture(t)
  for (const name of ['Bash', 'exec_command', 'apply_patch'])
    assert.equal(await check({ tool_name: name }), true)
  for (const name of ['mcp__computer__click', 'request_user_input', 'unknown', undefined])
    assert.equal(await check({ tool_name: name }), false)
  assert.equal(await check({ hook_event_name: 'PreToolUse' }), false)
  for (const policy of ['never', 'future-policy', { granular: {} }]) {
    await appendFile(path, jsonl(context('auto_review', 'turn-1', policy)))
    assert.equal(await check(), false)
  }
})

test('missing, out-of-root, malformed and incomplete files preserve the attention fallback', async (t) => {
  const { path, home, check } = await fixture(t)
  const outside = join(home, 'outside.jsonl')
  await writeFile(
    outside,
    jsonl({ type: 'session_meta', payload: { id: 'session-1' } }) + jsonl(context('auto_review')),
  )
  assert.equal(await check({ transcript_path: outside }), false)
  assert.equal(await check({ transcript_path: join(home, 'sessions', 'absent.jsonl') }), false)
  assert.equal(await check({ transcript_path: 'sessions/rollout.jsonl' }), false)
  await appendFile(path, '{"type":"turn_context","payload":')
  assert.equal(await check(), false)
  await appendFile(path, '\n')
  assert.equal(await check(), false)
  await writeFile(path, 'null\n' + jsonl(context('auto_review')))
  assert.equal(await check(), false)
})

test('bounded tail handles large rollouts without using stale context outside the read window', async (t) => {
  const { path, check } = await fixture(t)
  const padding = jsonl({ type: 'response_item', payload: 'x'.repeat(512 * 1024) })
  for (let i = 0; i < 18; i++) await appendFile(path, padding)
  assert.equal(await check(), false)
  await appendFile(path, jsonl(context('auto_review')))
  assert.equal(await check(), true)
})

test('other sessions and settings updates cannot inherit an automatic reviewer', async (t) => {
  const { home, path, reader, check } = await fixture(t)
  const manualPath = join(home, 'sessions', 'manual.jsonl')
  await writeFile(
    manualPath,
    jsonl({ type: 'session_meta', payload: { id: 'manual' } }) + jsonl(context('user')),
  )
  const manual = normalizeEvent(
    fromCodexHook(hook(manualPath, 'PermissionRequest', { session_id: 'manual' }))!,
  )
  const answers = await Promise.all([check(), reader.isAutomaticSandboxApproval(manual), check()])
  assert.deepEqual(answers, [true, false, true])
  await appendFile(
    path,
    jsonl({
      type: 'event_msg',
      payload: { type: 'thread_settings_applied', thread_settings: { approvals_reviewer: 'user' } },
    }),
  )
  assert.equal(await check(), false)
  await appendFile(path, jsonl(context('auto_review')))
  assert.equal(await check(), true)
  const input = {
    ...manual,
    eventType: 'user_input_required' as const,
    tokenSourcePath: path,
    externalSessionId: 'session-1',
  }
  assert.equal(await reader.isAutomaticSandboxApproval(input), false)
})

test('current desktop settings re-application must agree with the exact turn context', async (t) => {
  const { path, check } = await fixture(t)
  const settings = (reviewer: string | undefined) =>
    jsonl({
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_settings: { approval_policy: 'on-request', approvals_reviewer: reviewer },
      },
    })
  await appendFile(path, settings('auto_review'))
  assert.equal(await check(), true)
  await appendFile(path, settings('user'))
  assert.equal(await check(), false)
  await appendFile(path, settings('auto_review'))
  assert.equal(await check(), true)
  await appendFile(path, settings(undefined))
  assert.equal(await check(), false)
  await appendFile(path, jsonl(context('user')) + settings('auto_review'))
  assert.equal(await check(), false)
})
