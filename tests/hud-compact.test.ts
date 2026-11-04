import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { TurnState, type AgentRuntimeState } from '@codepulse/shared'
import { buildAgentPanels } from '../apps/hud/src/renderer/src/lib/displayAgents.js'
import {
  flattenTasks,
  islandBox,
  isUrgent,
  peekKey,
  pickPeek,
  summarize,
} from '../apps/hud/src/renderer/src/lib/hudCompact.js'
import { buildProjectDeckGroups } from '../apps/hud/src/renderer/src/lib/projectDeck.js'
import {
  elapsedMs,
  formatContextLabel,
} from '../apps/hud/src/renderer/src/lib/projectDeckFormat.js'

function agent(
  id: string,
  state: TurnState,
  extra: Partial<AgentRuntimeState> = {},
): AgentRuntimeState {
  return {
    agentType: 'codex',
    externalSessionId: id,
    workspacePath: `F:/Projects/${id}`,
    taskTitle: `Task ${id}`,
    state,
    lastEventAt: 100,
    unread: false,
    toolCallCount: 1,
    needPermission: false,
    needUserInput: false,
    ...extra,
  }
}

function tasksOf(agents: AgentRuntimeState[]) {
  const panels = buildAgentPanels(agents, { perTask: true })
  return flattenTasks(buildProjectDeckGroups(panels), 'Unknown')
}

const RUN = (id: string) => agent(id, TurnState.TOOL_RUNNING)
const DONE = (id: string, extra: Partial<AgentRuntimeState> = {}) =>
  agent(id, TurnState.DONE, { unread: true, terminalAt: 500, ...extra })
const WAIT = (id: string) => agent(id, TurnState.WAITING_PERMISSION)
const FAIL = (id: string) => agent(id, TurnState.ERROR, { unread: true })

test('flattening keeps the deck order and attaches title and level', () => {
  const tasks = tasksOf([RUN('a'), DONE('b'), WAIT('c'), agent('d', TurnState.IDLE)])
  assert.deepEqual(
    tasks.map((task) => task.card.agent.externalSessionId),
    ['a', 'b', 'c', 'd'],
  )
  assert.deepEqual(
    tasks.map((task) => task.level),
    ['active', 'notice', 'action', 'quiet'],
  )
  assert.equal(tasks[0]?.title, 'Task a')
  assert.equal(flattenTasks([], 'Unknown').length, 0)
})

test('summary counts running tasks and unread results', () => {
  const summary = summarize(tasksOf([RUN('a'), RUN('b'), DONE('c'), FAIL('d'), WAIT('e')]))
  assert.deepEqual(summary, { total: 5, running: 2, unread: 2 })
  assert.deepEqual(summarize([]), { total: 0, running: 0, unread: 0 })
  assert.equal(summarize(tasksOf([DONE('a', { unread: false })])).unread, 0)
})

test('peek always shows the most urgent fault or action task, even once seen', () => {
  const tasks = tasksOf([RUN('a'), WAIT('b'), FAIL('c'), DONE('d')])
  const seen = new Set(tasks.map(peekKey))
  assert.equal(pickPeek(tasks, new Set())?.card.agent.externalSessionId, 'c')
  assert.equal(pickPeek(tasks, seen)?.card.agent.externalSessionId, 'c')
  const waiting = tasksOf([RUN('a'), WAIT('b'), DONE('d')])
  assert.equal(pickPeek(waiting, new Set(waiting.map(peekKey)))?.level, 'action')
  assert.equal(isUrgent(pickPeek(waiting, new Set())), true)
})

test('a notice peeks until its key is spent, then only the unread mark remains', () => {
  const tasks = tasksOf([RUN('a'), DONE('b'), DONE('c')])
  assert.equal(pickPeek(tasks, new Set())?.card.agent.externalSessionId, 'b')
  const spent = new Set([peekKey(tasks[1]!)])
  assert.equal(pickPeek(tasks, spent)?.card.agent.externalSessionId, 'c')
  spent.add(peekKey(tasks[2]!))
  assert.equal(pickPeek(tasks, spent), undefined)
  assert.equal(pickPeek(tasksOf([RUN('a')]), new Set()), undefined)
  assert.equal(isUrgent(undefined), false)
})

test('peek key changes with state and completion time but not with passing events', () => {
  const [done] = tasksOf([DONE('a')])
  const [later] = tasksOf([DONE('a', { lastEventAt: 900 })])
  const [again] = tasksOf([DONE('a', { terminalAt: 800 })])
  const [failed] = tasksOf([agent('a', TurnState.ERROR, { unread: true, terminalAt: 500 })])
  assert.equal(peekKey(done!), peekKey(later!))
  assert.notEqual(peekKey(done!), peekKey(again!))
  assert.notEqual(peekKey(done!), peekKey(failed!))
  const [noTerminal] = tasksOf([DONE('a', { terminalAt: undefined, lastEventAt: 7 })])
  assert.match(peekKey(noTerminal!), /\|7$/)
})

test('island sizes follow the design', () => {
  const idle = summarize([])
  const box = (summary: typeof idle, extra: Partial<Parameters<typeof islandBox>[0]> = {}) =>
    islandBox({ open: false, peeking: false, summary, listHeight: 300, ...extra })
  assert.deepEqual(box(idle), { width: 128, height: 36, radius: 18 })
  assert.equal(box({ total: 2, running: 2, unread: 0 }).width, 216)
  assert.equal(box({ total: 1, running: 0, unread: 1 }).width, 216)
  assert.equal(box({ total: 3, running: 2, unread: 1 }).width, 272)
  assert.deepEqual(box(idle, { peeking: true }), { width: 420, height: 64, radius: 32 })
  assert.deepEqual(box(idle, { open: true }), { width: 460, height: 300, radius: 16 })
  assert.equal(box(idle, { open: true, listHeight: 900 }).height, 420)
})

test('formatters moved out of the project deck keep their output', () => {
  const running = agent('a', TurnState.TOOL_RUNNING, {
    turnStartedAt: 1_000,
    token: { accuracy: 'exact', contextUsedPercent: 43, contextWindow: 256_000 },
  })
  assert.equal(elapsedMs(running, 61_000), 60_000)
  assert.equal(elapsedMs(agent('b', TurnState.IDLE), 61_000), undefined)
  assert.match(formatContextLabel(running, 'en') ?? '', /^43% \(\d+(\.\d)?k\/256k\)$/)
  assert.equal(formatContextLabel(agent('c', TurnState.IDLE), 'en'), undefined)
})

const compactDir = 'apps/hud/src/renderer/src/components/compact'

test('compact surfaces never reach into the preload API directly', () => {
  for (const file of readdirSync(compactDir).filter((name) => name.endsWith('.tsx'))) {
    assert.doesNotMatch(readFileSync(`${compactDir}/${file}`, 'utf8'), /window\.codepulse/, file)
  }
  const hook = readFileSync('apps/hud/src/renderer/src/lib/useHudHitTest.ts', 'utf8')
  assert.doesNotMatch(hook, /window\.codepulse/)
})

test('compact stylesheet keeps to the type scale and respects the window rules', () => {
  const css = readFileSync(`${compactDir}/hud-compact.css`, 'utf8')
  const sizes = new Set([...css.matchAll(/font-size:\s*(\d+)px/g)].map((match) => match[1]))
  assert.deepEqual([...sizes].sort(), ['12', '13', '14', '16'])
  const weights = new Set([...css.matchAll(/font-weight:\s*(\d+)/g)].map((match) => match[1]))
  assert.deepEqual([...weights].sort(), ['400', '600'])
  assert.match(css, /body\[data-surface='hud-compact'\]\s*\{\s*padding: 0/)
  assert.match(css, /\[data-hud-surface='compact'\]::before\s*\{\s*display: none/)
  assert.match(css, /prefers-reduced-motion: reduce/)
  assert.match(css, /0\.86 \+ 0\.14 \* var\(--hud-opacity/)
  assert.match(css, /--c-action-ink: #c2410c/)
  assert.match(css, /\[data-attention-effect='breathe'\] \.hud-c-urgent/)
  assert.match(css, /\[data-attention-effect='pulse'\] \.hud-c-urgent/)
})

test('app shell marks the surface and keeps modals clickable on the transparent stage', () => {
  const app = readFileSync('apps/hud/src/renderer/src/App.tsx', 'utf8')
  assert.match(app, /data-hud-surface=\{compactStyle \? 'compact' : 'panel'\}/)
  assert.match(app, /'hud-compact'/)
  assert.equal(app.match(/hud-modal-overlay[^\n]*\r?\n\s*data-hud-hit/g)?.length, 2)
  assert.doesNotMatch(
    readFileSync('apps/hud/src/renderer/src/index.css', 'utf8'),
    /hud-compact|data-hud-surface/,
  )
})
