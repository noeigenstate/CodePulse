// CodePulse 后端管线的端到端冒烟测试：
// hook 载荷 -> POST /api/events -> 适配器 -> StatusHub（状态机 +
// 规则引擎）-> GET /api/status 与 /api/device/status。
// 不涉及 Electron，也不涉及 SQLite。
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuleEngine, STUCK_STRONG_MS, STUCK_VISIBLE_MS, StatusHub } from '@codepulse/core'
import { detectCodexAgent, startLocalServer } from '@codepulse/local-server'
import {
  formatTokenCount,
  formatTokenPercent,
  formatTokenUsage,
  type AgentRuntimeState,
  type NotificationRequest,
  TurnState,
} from '@codepulse/shared'
import { persistEvent } from '../packages/storage/src/repository.js'
import { events, sessions, tokenSnapshots, turns } from '../packages/storage/src/sqlite/schema.js'
import { buildDisplayAgents } from '../apps/desktop/src/renderer/src/lib/displayAgents.js'
import { useStore } from '../apps/desktop/src/renderer/src/store.js'

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

function createFakeDb() {
  const rows = {
    events: [] as Record<string, unknown>[],
    sessions: [] as Record<string, unknown>[],
    turns: [] as Record<string, unknown>[],
    tokenSnapshots: [] as Record<string, unknown>[],
  }

  function bucket(table: unknown): Record<string, unknown>[] {
    if (table === events) return rows.events
    if (table === sessions) return rows.sessions
    if (table === turns) return rows.turns
    if (table === tokenSnapshots) return rows.tokenSnapshots
    throw new Error('unknown fake table')
  }

  const db = {
    rows,
    transaction<T>(fn: (tx: typeof db) => T): T {
      return fn(db)
    },
    insert(table: unknown) {
      return {
        values(value: Record<string, unknown>) {
          return {
            run() {
              bucket(table).push({ ...value })
            },
          }
        },
      }
    },
    select() {
      let table: unknown
      const query = {
        from(nextTable: unknown) {
          table = nextTable
          return query
        },
        where() {
          return query
        },
        orderBy() {
          return query
        },
        limit() {
          return query
        },
        all() {
          const data = [...bucket(table)]
          if (table === turns) data.sort((a, b) => Number(b.startedAt) - Number(a.startedAt))
          return data
        },
      }
      return query
    },
    update(table: unknown) {
      return {
        set(value: Record<string, unknown>) {
          return {
            where() {
              return {
                run() {
                  for (const row of bucket(table)) Object.assign(row, value)
                },
              }
            },
          }
        },
      }
    },
  }

  return db as typeof db & Parameters<typeof persistEvent>[0]
}

try {
  // --- 共享 token 格式化 ------------------------------------------------
  check('token count formats thousands', formatTokenCount(66899) === '66.9k')
  check('token count formats millions', formatTokenCount(1_000_000) === '1M')
  check(
    'token usage labels million counts as token units',
    formatTokenUsage({ accuracy: 'estimated', total: 1_000_000 }) === '总计 1M token',
  )
  check('token percent formats as percentage', formatTokenPercent(83.4) === '83%')
  check(
    'dashboard display always includes Codex slot',
    buildDisplayAgents([]).some((agent) => agent.agentType === 'codex'),
  )

  // --- Codex 本地检测 --------------------------------------------------
  const detectTmp = await mkdtemp(join(tmpdir(), 'codepulse-codex-detect-'))
  try {
    const configPath = join(detectTmp, 'config.toml')
    await writeFile(
      configPath,
      `hooks = ["node E:/repo/packages/hooks/bin/codex-hook.js"]\n`,
      'utf8',
    )
    const detected = await detectCodexAgent({
      env: { CODEPULSE_CODEX_CONFIG_FILE: configPath },
      runCommand: async () => ({ ok: true, stdout: 'codex-cli 1.2.3' }),
    })
    check('codex detection reports installed', detected.installed === true)
    check('codex detection reports configured hook', detected.configured === true)
    check('codex detection captures version', detected.version === 'codex-cli 1.2.3')

    let probedCommand = ''
    await detectCodexAgent({
      env: { CODEPULSE_CODEX_CONFIG_FILE: configPath },
      platform: 'win32',
      runCommand: async (command) => {
        probedCommand = command
        return { ok: true, stdout: 'codex-cli 1.2.3' }
      },
    })
    check('codex detection probes .cmd on Windows', probedCommand.endsWith('codex.cmd'))
  } finally {
    await rm(detectTmp, { recursive: true, force: true })
  }

  // --- 卡住状态应进入 TIMEOUT / stuck ---------------------------------
  const stuckHub = new StatusHub({ sessionThrottleMs: 0 })
  const stuckAt = 1_000_000
  stuckHub.ingest({
    id: 'stuck-prompt',
    source: 'codex',
    eventType: 'prompt_submit',
    externalSessionId: 'stuck-session',
    timestamp: stuckAt,
  })
  ;(stuckHub as unknown as { tick(now?: number): void }).tick(stuckAt + STUCK_VISIBLE_MS + 1)
  const stuckSnap = stuckHub.snapshot(stuckAt + STUCK_VISIBLE_MS + 1)
  check(
    'watchdog marks agent TIMEOUT at visible stuck threshold',
    stuckSnap.agents[0]?.state === TurnState.TIMEOUT,
  )
  check('watchdog makes aggregate stuck reachable', stuckSnap.overall === 'stuck')

  const terminalRuleEngine = new RuleEngine({ sessionThrottleMs: 0 })
  const timeoutAgent: AgentRuntimeState = {
    agentType: 'codex',
    state: TurnState.TIMEOUT,
    toolCallCount: 0,
    needPermission: false,
    needUserInput: false,
    lastEventAt: stuckAt,
    unread: false,
  }
  const timeoutStrongNotes = terminalRuleEngine.onTick(timeoutAgent, stuckAt + STUCK_STRONG_MS + 1)
  check('rule engine suppresses stuck notifications', timeoutStrongNotes.length === 0)
  check(
    'rule engine keeps repeated stuck checks silent',
    terminalRuleEngine.onTick(timeoutAgent, stuckAt + STUCK_STRONG_MS + 2).length === 0,
  )

  // --- 通知去重缓存应清理旧键 -----------------------------------------
  const cleanupEngine = new RuleEngine({ sessionThrottleMs: 0 })
  for (let i = 0; i < 8; i++) {
    cleanupEngine.onTransition(
      {
        previous: {
          agentType: 'codex',
          state: TurnState.TOOL_RUNNING,
          externalTurnId: `turn-${i}`,
          turnStartedAt: i,
          toolCallCount: 0,
          needPermission: false,
          needUserInput: false,
          lastEventAt: i,
          unread: false,
        },
        previousState: TurnState.TOOL_RUNNING,
        next: {
          agentType: 'codex',
          state: TurnState.DONE,
          externalTurnId: `turn-${i}`,
          toolCallCount: 0,
          needPermission: false,
          needUserInput: false,
          lastEventAt: i,
          unread: true,
        },
        turnEnded: true,
      },
      i * 120_000,
    )
  }
  const firedMap = (cleanupEngine as unknown as { lastFiredAt: Map<string, number> }).lastFiredAt
  check('rule engine prunes old fired notification keys', firedMap.size < 8)

  // --- 存储：终结状态不可被后续重复 stop 覆盖，token turnId 使用内部 id ----
  const fakeDb = createFakeDb()
  persistEvent(fakeDb, {
    id: 'storage-prompt',
    source: 'codex',
    eventType: 'prompt_submit',
    externalSessionId: 'storage-session',
    externalTurnId: 'external-turn',
    timestamp: 10,
  })
  persistEvent(fakeDb, {
    id: 'storage-error',
    source: 'codex',
    eventType: 'turn_error',
    externalSessionId: 'storage-session',
    externalTurnId: 'external-turn',
    message: 'failed',
    timestamp: 20,
  })
  persistEvent(fakeDb, {
    id: 'storage-stop',
    source: 'codex',
    eventType: 'turn_stop',
    externalSessionId: 'storage-session',
    externalTurnId: 'external-turn',
    message: 'done',
    timestamp: 30,
  })
  persistEvent(fakeDb, {
    id: 'storage-token',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'storage-session',
    externalTurnId: 'external-turn',
    token: { total: 42, accuracy: 'estimated' },
    timestamp: 40,
  })
  const storedTurn = fakeDb.rows.turns[0]
  const storedToken = fakeDb.rows.tokenSnapshots[0]
  check(
    'storage keeps ERROR turn from being overwritten by later stop',
    storedTurn?.state === 'ERROR',
  )
  check(
    'storage token snapshot turnId uses internal turn id',
    storedToken?.turnId === storedTurn?.id,
  )

  // --- 渲染端：同 dedupeKey 的通知只删除指定一条 -----------------------
  useStore.setState({
    notifications: [
      { level: 'soft', title: 'n1', body: 'one', dedupeKey: 'same', sound: false, createdAt: 1 },
      { level: 'soft', title: 'n2', body: 'two', dedupeKey: 'same', sound: false, createdAt: 2 },
    ],
  })
  useStore.getState().dismissNotification('same', 1)
  const remainingNotes = useStore.getState().notifications
  check(
    'renderer dismiss removes only the selected notification instance',
    remainingNotes.length === 1 && remainingNotes[0]?.createdAt === 2,
  )

  // --- Claude Code：一次以授权请求结尾的提示 ----------------
  await post({
    source: 'claude_code',
    hook_event_name: 'SessionStart',
    session_id: 'c1',
    cwd: 'E:/proj/ai-hardware',
  })
  await post({
    source: 'claude_code',
    hook_event_name: 'UserPromptSubmit',
    session_id: 'c1',
    prompt: '请帮我跑测试',
  })
  await post({
    source: 'claude_code',
    hook_event_name: 'PreToolUse',
    session_id: 'c1',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  })

  let snap = await status()
  const claude = snap.agents.find((a) => a.agentType === 'claude_code')
  check('claude agent exists', !!claude)
  check('claude is TOOL_RUNNING', claude?.state === 'TOOL_RUNNING')
  check('claude toolCallCount = 1', claude?.toolCallCount === 1)
  check('claude workspace captured', claude?.workspacePath === 'E:/proj/ai-hardware')
  check('overall = running', snap.overall === 'running')

  await post({
    source: 'claude_code',
    hook_event_name: 'Notification',
    session_id: 'c1',
    message: 'Claude needs your permission to run npm test',
  })
  snap = await status()
  check(
    'claude is WAITING_PERMISSION',
    snap.agents.find((a) => a.agentType === 'claude_code')?.state === 'WAITING_PERMISSION',
  )
  check('overall = attention', snap.overall === 'attention')
  check(
    'permission notification suppressed',
    !notifications.some((n) => n.dedupeKey.startsWith('perm:')),
  )

  // --- Claude status line：token 快照 -------------------------------------
  await post({
    source: 'claude_code',
    channel: 'statusline',
    session_id: 'c1',
    model: { display_name: 'Claude Sonnet' },
    workspace: { current_dir: 'E:/proj/ai-hardware' },
    context_used_percent: 83,
    cost: { total_cost_usd: 0.42 },
    rate_limits: {
      primary: { used_percent: 61, window_minutes: 300, resets_at: 1_000_005_400 },
      secondary: { used_percent: 12, window_minutes: 10080, resets_at: 1_000_561_600 },
    },
  })
  snap = await status()
  const claudeTok = snap.agents.find((a) => a.agentType === 'claude_code')
  check('context % captured = 83', claudeTok?.token?.contextUsedPercent === 83)
  check('model captured', claudeTok?.model === 'Claude Sonnet')
  check(
    'claude context quota notification suppressed',
    !notifications.some(
      (n) => n.dedupeKey.startsWith('ctx:claude_code:') && n.dedupeKey.endsWith(':soft'),
    ),
  )
  const claudeCtxNote = notifications.find(
    (n) => n.dedupeKey.startsWith('ctx:claude_code:') && n.dedupeKey.endsWith(':soft'),
  )
  check('claude token notification absent', claudeCtxNote === undefined)
  check(
    'claude token quota notification absent',
    claudeCtxNote === undefined ||
      (claudeCtxNote.body.includes('每周') && claudeCtxNote.body.includes('刷新')),
  )

  await post({
    source: 'claude_code',
    channel: 'statusline',
    session_id: 'c1',
    model: { display_name: 'Claude Sonnet' },
    context_used_percent: 83,
    context_window: {
      total_input_tokens: 24000,
      total_output_tokens: 1000,
      used_percentage: 12.5,
      context_window_size: 200000,
    },
  })
  snap = await status()
  const claudeOfficialCtx = snap.agents.find((a) => a.agentType === 'claude_code')
  check(
    'claude statusline prefers official context_window percentage',
    claudeOfficialCtx?.token?.contextUsedPercent === 12.5,
  )

  // --- Codex：提示 -> 结束 --------------------------------------------------
  await post({
    source: 'codex',
    hook_event_name: 'UserPromptSubmit',
    session_id: 'x1',
    cwd: 'E:/proj/dingcode',
  })
  await post({
    source: 'codex',
    hook_event_name: 'Stop',
    session_id: 'x1',
    last_message: '完成重构',
    usage: {
      input_tokens: 118000,
      output_tokens: 2000,
      total_tokens: 120000,
      context_used_percent: 96,
    },
    rate_limits: {
      primary: { used_percent: 72, window_minutes: 300, resets_at: 1_000_005_400 },
      secondary: { used_percent: 18, window_minutes: 10080, resets_at: 1_000_561_600 },
    },
  })
  snap = await status()
  const codex = snap.agents.find((a) => a.agentType === 'codex')
  check('codex is DONE', codex?.state === 'DONE')
  check('codex unread', codex?.unread === true)
  check('codex last message', codex?.lastAssistantMessage === '完成重构')
  check('codex token total captured', codex?.token?.total === 120000)
  check('codex context % captured = 96', codex?.token?.contextUsedPercent === 96)
  check(
    'done notification fired (normal)',
    notifications.some((n) => n.level === 'normal' && n.dedupeKey.startsWith('done:')),
  )
  const codexCtxNote = notifications.find(
    (n) => n.dedupeKey.startsWith('ctx:codex:') && n.dedupeKey.endsWith(':strong'),
  )
  check('codex context quota notification suppressed', codexCtxNote === undefined)
  check('codex token notification absent', codexCtxNote === undefined)
  check(
    'codex token quota notification absent',
    codexCtxNote === undefined ||
      (codexCtxNote.body.includes('每周') && codexCtxNote.body.includes('刷新')),
  )

  await post({
    source: 'codex',
    hook_event_name: 'UserPromptSubmit',
    session_id: 'x-cancel',
    turn_id: 'cancel-turn',
    cwd: 'E:/proj/dingcode',
  })
  await post({
    source: 'codex',
    hook_event_name: 'Cancelled',
    session_id: 'x-cancel',
    turn_id: 'cancel-turn',
    message: '用户取消',
  })
  snap = await status()
  const cancelledCodex = snap.agents.find((a) => a.agentType === 'codex')
  check('codex cancel maps to CANCELLED', cancelledCodex?.state === 'CANCELLED')
  check(
    'cancelled notification suppressed',
    !notifications.some((n) => n.dedupeKey.startsWith('cancelled:')),
  )

  // --- 确认操作清除未读 ---------------------------------------------
  await fetch(`${base}/api/ack/codex`, { method: 'POST' })
  snap = await status()
  check(
    'codex unread cleared after ack',
    snap.agents.find((a) => a.agentType === 'codex')?.unread === false,
  )

  // --- 设备状态投影 ----------------------------------------------
  const dev = await (await fetch(`${base}/api/device/status`)).json()
  check('device mainState = waiting_permission', dev.mainState === 'waiting_permission')
  check('device claudeContext = 12.5', dev.claudeContext === 12.5)
  check('device activeAgent = claude_code', dev.activeAgent === 'claude_code')

  // --- agent 检测 API ----------------------------------------------------
  const agents = await (await fetch(`${base}/api/agents/detect`)).json()
  check(
    'agent detection API includes codex',
    agents.agents.some((a: { type: string }) => a.type === 'codex'),
  )
  check(
    'agent detection API reports codex booleans',
    agents.agents.some(
      (a: { type: string; installed: unknown; configured: unknown }) =>
        a.type === 'codex' && typeof a.installed === 'boolean' && typeof a.configured === 'boolean',
    ),
  )

  // --- 未知载荷被拒绝而非导致崩溃 -----------------------------
  const bad = await fetch(`${base}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ foo: 'bar' }),
  })
  check('unknown event -> 400', bad.status === 400)
} finally {
  await server.close()
}

console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
