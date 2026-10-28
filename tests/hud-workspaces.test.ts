import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StatusHub } from '@codepulse/core'
import {
  TurnState,
  workspaceKey,
  type AgentRuntimeState,
  type StatusSnapshot,
} from '@codepulse/shared'
import { HudProjection } from '../apps/desktop/src/main/hud-projection.js'
import { HUD_WORKSPACE_LIMIT, HudWorkspaces } from '../apps/desktop/src/main/hud-workspaces.js'

function row(id: string, path?: string, extra: Partial<AgentRuntimeState> = {}): AgentRuntimeState {
  return {
    agentType: 'codex',
    state: TurnState.THINKING,
    workspacePath: path,
    externalSessionId: id,
    lastEventAt: Date.now(),
    toolCallCount: 0,
    needPermission: false,
    needUserInput: false,
    unread: false,
    ...extra,
  }
}
function snapshot(agents: AgentRuntimeState[]): StatusSnapshot {
  return { overall: 'running', updatedAt: Date.now(), agents }
}

test('HUD projects stable session workspaces through cwd, title, status and input-order changes', () => {
  const hud = new HudProjection()
  const initial = [row('a', 'file:///F:/Projects/Alpha'), row('b', 'F:\\Projects\\Beta')]
  hud.snapshot(snapshot(initial))
  for (let i = 0; i < 40; i++) {
    const raw = snapshot([
      row('b', i % 2 ? 'F:/Projects/Alpha' : 'file:///F:/Projects/Beta', {
        taskTitle: `title ${i}`,
        state: TurnState.DONE,
        unread: true,
      }),
      row('a', i % 2 ? 'F:/Projects/Beta' : 'F:/Projects/Alpha/subdir', {
        state: TurnState.TOOL_RUNNING,
      }),
    ])
    const before = structuredClone(raw)
    const shown = hud.snapshot(raw)
    assert.deepEqual(
      shown.agents.map((a) => [a.externalSessionId, workspaceKey(a.workspacePath)]),
      [
        ['b', 'f:/projects/beta'],
        ['a', 'f:/projects/alpha'],
      ],
    )
    assert.equal(shown.agents[0]?.taskTitle, `title ${i}`)
    assert.equal(shown.agents[1]?.state, TurnState.TOOL_RUNNING)
    assert.deepEqual(raw, before)
  }
})

test('URI, separator, case and escaped spaces share a project while providers remain independent', () => {
  const hud = new HudProjection()
  const shown = hud.snapshot(
    snapshot([
      row('same', 'file:///F:/Projects/My%20Project'),
      row('same', 'f:\\projects\\my project', { agentType: 'claude_code' }),
      row('unc', 'file://server/share/My%20Project'),
    ]),
  )
  assert.equal(
    workspaceKey(shown.agents[0]?.workspacePath),
    workspaceKey(shown.agents[1]?.workspacePath),
  )
  assert.equal(shown.agents[2]?.workspacePath, '//server/share/My Project')
  const next = hud.snapshot(snapshot([row('same', 'F:/elsewhere', { agentType: 'claude_code' })]))
  assert.equal(workspaceKey(next.agents[0]?.workspacePath), 'f:/projects/my project')
})

test('pathless sessions bind when metadata arrives and survive absence or hidden snapshots', () => {
  const hud = new HudProjection()
  assert.equal(hud.snapshot(snapshot([row('a')])).agents[0]?.workspacePath, undefined)
  assert.equal(hud.snapshot(snapshot([row('a', 'F:/Alpha')])).agents[0]?.workspacePath, 'F:/Alpha')
  hud.snapshot(snapshot([]))
  hud.snapshot(snapshot([row('a', 'F:/Beta', { taskHidden: true })]))
  assert.equal(hud.snapshot(snapshot([row('a')])).agents[0]?.workspacePath, 'F:/Alpha')
})

test('bindings persist across restarts without saving raw session IDs or task contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hud-bindings-'))
  try {
    const path = join(dir, 'bindings.json')
    const first = new HudProjection(path)
    first.snapshot(
      snapshot([row('private-native-session', 'F:/Alpha', { taskTitle: 'private task prompt' })]),
    )
    const saved = readFileSync(path, 'utf8')
    assert.ok(!saved.includes('private-native-session') && !saved.includes('private task prompt'))
    const restarted = new HudProjection(path)
    assert.equal(
      restarted.snapshot(snapshot([row('private-native-session', 'F:/Beta')])).agents[0]
        ?.workspacePath,
      'F:/Alpha',
    )
    writeFileSync(path, '{broken')
    assert.equal(
      new HudProjection(path).snapshot(snapshot([row('new', 'F:/New')])).agents[0]?.workspacePath,
      'F:/New',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('failed persistence retains in-memory bindings and does not suppress status updates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hud-bindings-'))
  try {
    let errors = 0
    const hud = new HudProjection(join(dir, 'absent', 'bindings.json'), () => {
      errors++
    })
    hud.snapshot(snapshot([row('a', 'F:/Alpha')]))
    const shown = hud.snapshot(
      snapshot([row('a', 'F:/Beta', { state: TurnState.WAITING_PERMISSION })]),
    )
    assert.equal(errors, 2) // Workspace binding and common order each report their failed save once.
    assert.equal(shown.agents[0]?.workspacePath, 'F:/Alpha')
    assert.equal(shown.agents[0]?.state, TurnState.WAITING_PERMISSION)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('history bound evicts absent sessions while preserving live bindings', () => {
  const bindings = new HudWorkspaces()
  bindings.project(Array.from({ length: HUD_WORKSPACE_LIMIT }, (_, i) => row(`s${i}`, `F:/P${i}`)))
  bindings.project([row('s0', 'F:/Wrong'), row('new', 'F:/New')])
  assert.equal(bindings.project([row('s0', 'F:/Wrong')])[0]?.workspacePath, 'F:/P0')
  assert.equal(bindings.project([row('s1', 'F:/Rebound')])[0]?.workspacePath, 'F:/Rebound')
})

test('dismissal follows a session through cwd changes but fresh activity restores it', () => {
  const hud = new HudProjection()
  hud.snapshot(snapshot([row('a', 'F:/Alpha'), row('b', 'F:/Beta')]))
  const moved = snapshot([row('a', 'F:/Beta'), row('b', 'F:/Beta')])
  assert.equal(hud.dismiss(moved, 'codex', 'F:/Alpha', 'a'), true)
  const shown = hud.snapshot(moved)
  assert.equal(shown.agents[0]?.taskHidden, true)
  assert.equal(shown.agents[1]?.taskHidden, undefined)
  const fresh = hud.snapshot(snapshot([row('a', 'F:/Gamma', { toolCallCount: 1 })]))
  assert.equal(fresh.agents[0]?.taskHidden, undefined)
  assert.equal(fresh.agents[0]?.workspacePath, 'F:/Alpha')
})

test('read acknowledgement resolves projected project sessions without clearing cwd neighbours', () => {
  const hub = new StatusHub()
  const hud = new HudProjection()
  for (const [id, path] of [
    ['a', 'F:/Alpha'],
    ['child', 'F:/Alpha/subdir'],
    ['b', 'F:/Beta'],
  ]) {
    hub.ingest({
      id: `prompt-${id}`,
      source: 'codex',
      eventType: 'prompt_submit',
      externalSessionId: id,
      cwd: path,
      timestamp: Date.now(),
    })
  }
  hud.snapshot(hub.snapshot())
  // All three sessions now execute in the same directory. Only the two
  // displayed under Alpha may be acknowledged by Alpha's button.
  for (const id of ['a', 'child', 'b'])
    hub.ingest({
      id: `done-${id}`,
      source: 'codex',
      eventType: 'turn_stop',
      externalSessionId: id,
      cwd: 'F:/Beta',
      timestamp: Date.now(),
    })
  let updates = 0
  hub.on('status', () => {
    updates++
  })
  hub.acknowledgeRows(hud.rowsForProject(hub.snapshot(), 'codex', 'F:/Alpha'))
  assert.equal(updates, 1)
  assert.deepEqual(
    Object.fromEntries(hub.snapshot().agents.map((a) => [a.externalSessionId, a.unread])),
    { a: false, child: false, b: true },
  )
  hub.acknowledgeRows([])
  assert.equal(updates, 1)
  // The classic desktop keeps its original workspace-wide contract.
  hub.acknowledge('codex', 'F:/Beta')
  assert.ok(hub.snapshot().agents.every((a) => !a.unread))
})

test('legacy path-only acknowledgement cannot clear session-backed tasks sharing that path', () => {
  const hub = new StatusHub()
  for (const session of [undefined, 'native']) {
    hub.ingest({
      id: `prompt-${session}`,
      source: 'codex',
      eventType: 'prompt_submit',
      externalSessionId: session,
      cwd: 'F:/Shared',
      timestamp: Date.now(),
    })
    hub.ingest({
      id: `done-${session}`,
      source: 'codex',
      eventType: 'turn_stop',
      externalSessionId: session,
      cwd: 'F:/Shared',
      timestamp: Date.now(),
    })
  }
  assert.ok(hub.snapshot().agents.every((a) => a.unread))
  const legacy = hub.snapshot().agents.filter((a) => !a.externalSessionId)
  hub.acknowledgeRows(legacy)
  assert.equal(hub.snapshot().agents.find((a) => a.externalSessionId === 'native')?.unread, true)
})

test('acknowledging a generic container never clears its separate project cards', () => {
  const hud = new HudProjection()
  for (const path of ['F:/Projects', 'C:/Users/dev', '/home/dev', 'F:/']) {
    const source = snapshot([row('parent-' + path, path), row('child-' + path, path + '/Separate')])
    hud.snapshot(source)
    assert.deepEqual(
      hud.rowsForProject(source, 'codex', path).map((a) => a.externalSessionId),
      ['parent-' + path],
    )
  }
})
