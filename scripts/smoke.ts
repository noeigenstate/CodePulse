// End-to-end smoke test for the CodePulse backend pipeline:
// hook payload -> POST /api/events -> adapter -> StatusHub (state machine +
// rule engine) -> GET /api/status & /api/device/status. No Electron, no SQLite.
import assert from 'node:assert/strict'
import { StatusHub } from '@codepulse/core'
import { startLocalServer } from '@codepulse/local-server'
import type { NotificationRequest } from '@codepulse/shared'

const hub = new StatusHub()
const notifications: NotificationRequest[] = []
hub.on('notification', (n) => notifications.push(n))

const server = await startLocalServer({ hub, port: 17999 })
const base = server.url

async function post(payload: unknown): Promise<void> {
  const res = await fetch(`${base}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  assert.ok(res.status === 202 || res.status === 400, `unexpected status ${res.status}`)
}

async function status() {
  const res = await fetch(`${base}/api/status`)
  return res.json() as Promise<import('@codepulse/shared').StatusSnapshot>
}

let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.error(`  ✗ ${name}`)
  }
}

try {
  // --- Claude Code: a prompt that ends in a permission request ----------------
  await post({ source: 'claude_code', hook_event_name: 'SessionStart', session_id: 'c1', cwd: 'E:/proj/ai-hardware' })
  await post({ source: 'claude_code', hook_event_name: 'UserPromptSubmit', session_id: 'c1', prompt: '请帮我跑测试' })
  await post({ source: 'claude_code', hook_event_name: 'PreToolUse', session_id: 'c1', tool_name: 'Bash', tool_input: { command: 'npm test' } })

  let snap = await status()
  const claude = snap.agents.find((a) => a.agentType === 'claude_code')
  check('claude agent exists', !!claude)
  check('claude is TOOL_RUNNING', claude?.state === 'TOOL_RUNNING')
  check('claude toolCallCount = 1', claude?.toolCallCount === 1)
  check('claude workspace captured', claude?.workspacePath === 'E:/proj/ai-hardware')
  check('overall = running', snap.overall === 'running')

  await post({ source: 'claude_code', hook_event_name: 'Notification', session_id: 'c1', message: 'Claude needs your permission to run npm test' })
  snap = await status()
  check('claude is WAITING_PERMISSION', snap.agents.find((a) => a.agentType === 'claude_code')?.state === 'WAITING_PERMISSION')
  check('overall = attention', snap.overall === 'attention')
  check('permission notification fired (strong)', notifications.some((n) => n.level === 'strong' && n.dedupeKey.startsWith('perm:')))

  // --- Claude status line: token snapshot -------------------------------------
  await post({ source: 'claude_code', channel: 'statusline', session_id: 'c1', model: { display_name: 'Claude Sonnet' }, workspace: { current_dir: 'E:/proj/ai-hardware' }, context_used_percent: 83, cost: { total_cost_usd: 0.42 } })
  snap = await status()
  const claudeTok = snap.agents.find((a) => a.agentType === 'claude_code')
  check('context % captured = 83', claudeTok?.token?.contextUsedPercent === 83)
  check('model captured', claudeTok?.model === 'Claude Sonnet')
  check('context>80 soft notification fired', notifications.some((n) => n.dedupeKey === 'ctx:claude_code:soft'))

  // --- Codex: prompt -> stop --------------------------------------------------
  await post({ source: 'codex', hook_event_name: 'UserPromptSubmit', session_id: 'x1', cwd: 'E:/proj/dingcode' })
  await post({ source: 'codex', hook_event_name: 'Stop', session_id: 'x1', last_message: '完成重构' })
  snap = await status()
  const codex = snap.agents.find((a) => a.agentType === 'codex')
  check('codex is DONE', codex?.state === 'DONE')
  check('codex unread', codex?.unread === true)
  check('codex last message', codex?.lastAssistantMessage === '完成重构')
  check('done notification fired (normal)', notifications.some((n) => n.level === 'normal' && n.dedupeKey.startsWith('done:')))

  // --- Acknowledge clears unread ---------------------------------------------
  await fetch(`${base}/api/ack/codex`, { method: 'POST' })
  snap = await status()
  check('codex unread cleared after ack', snap.agents.find((a) => a.agentType === 'codex')?.unread === false)

  // --- Device status projection ----------------------------------------------
  const dev = await (await fetch(`${base}/api/device/status`)).json()
  check('device mainState = waiting_permission', dev.mainState === 'waiting_permission')
  check('device claudeContext = 83', dev.claudeContext === 83)
  check('device activeAgent = claude_code', dev.activeAgent === 'claude_code')

  // --- Unknown payloads are rejected, not crashed -----------------------------
  const bad = await fetch(`${base}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ foo: 'bar' }) })
  check('unknown event -> 400', bad.status === 400)
} finally {
  await server.close()
}

console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
