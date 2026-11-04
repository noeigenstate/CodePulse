import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { TurnState, type AgentRuntimeState } from '@codepulse/shared'
import { buildAgentPanels } from '../apps/hud/src/renderer/src/lib/displayAgents.js'
import {
  flattenTasks,
  islandBox,
  isUrgent,
  orbPopupMaxHeight,
  peekKey,
  pickPeek,
  summarize,
  topTask,
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
  assert.deepEqual(summary, { running: 2, unread: 2 })
  assert.deepEqual(summarize([]), { running: 0, unread: 0 })
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
  assert.equal(box({ running: 2, unread: 0 }).width, 216)
  assert.equal(box({ running: 0, unread: 1 }).width, 216)
  assert.equal(box({ running: 2, unread: 1 }).width, 272)
  assert.deepEqual(box(idle, { peeking: true }), { width: 420, height: 64, radius: 32 })
  assert.deepEqual(box(idle, { open: true }), { width: 460, height: 300, radius: 16 })
  assert.equal(box(idle, { open: true, listHeight: 900 }).height, 420)
})

test('the orb badge shows the most urgent task, or none when everything is quiet', () => {
  const level = (agents: AgentRuntimeState[]) => topTask(tasksOf(agents))?.level
  assert.equal(level([RUN('a'), DONE('b'), WAIT('c'), FAIL('d')]), 'fault')
  assert.equal(level([RUN('a'), DONE('b'), WAIT('c')]), 'action')
  assert.equal(level([RUN('a'), DONE('b')]), 'notice')
  assert.equal(level([agent('a', TurnState.IDLE), RUN('b')]), 'active')
  assert.equal(level([agent('a', TurnState.IDLE)]), undefined)
  assert.equal(topTask([]), undefined)
  const [first] = tasksOf([DONE('a'), DONE('b')])
  assert.equal(topTask(tasksOf([DONE('a'), DONE('b')]))?.card.id, first?.card.id)
})

test('orb popup is capped by the room left on short displays', () => {
  const base = { stageHeight: 504, availTop: 0, availHeight: 1040 }
  assert.equal(orbPopupMaxHeight({ ...base, anchorV: 'top', windowY: 40 }), 392)
  // Orb near the bottom of a 600px work area: popup starts at windowY + 88.
  assert.equal(
    orbPopupMaxHeight({
      anchorV: 'top',
      windowY: 200,
      stageHeight: 504,
      availTop: 0,
      availHeight: 600,
    }),
    304,
  )
  // Bottom anchored: the popup ends 88px above the stage bottom and opens upward.
  assert.equal(
    orbPopupMaxHeight({
      anchorV: 'bottom',
      windowY: -100,
      stageHeight: 504,
      availTop: 0,
      availHeight: 600,
    }),
    308,
  )
  assert.equal(
    orbPopupMaxHeight({
      anchorV: 'bottom',
      windowY: 0,
      stageHeight: 504,
      availTop: 0,
      availHeight: 600,
    }),
    392,
  )
  // Never below a few rows, and bad input falls back to the full height.
  assert.equal(
    orbPopupMaxHeight({
      anchorV: 'top',
      windowY: 560,
      stageHeight: 504,
      availTop: 0,
      availHeight: 600,
    }),
    96,
  )
  assert.equal(
    orbPopupMaxHeight({
      anchorV: 'top',
      windowY: Number.NaN,
      stageHeight: 504,
      availTop: 0,
      availHeight: 600,
    }),
    392,
  )
  // A second display above or to the side has its own availTop.
  assert.equal(
    orbPopupMaxHeight({
      anchorV: 'top',
      windowY: -900,
      stageHeight: 504,
      availTop: -1080,
      availHeight: 1080,
    }),
    392,
  )
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

/** The body of the first block that opens with `header`, braces balanced. */
function cssBlock(css: string, header: string): string {
  const start = css.indexOf(header)
  assert.ok(start >= 0, header)
  const open = css.indexOf('{', start)
  let depth = 0
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    if (css[index] === '}' && --depth === 0) return css.slice(open + 1, index)
  }
  throw new Error('unbalanced block: ' + header)
}

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
  const reduced = cssBlock(css, '@media (prefers-reduced-motion: reduce)')
  assert.match(reduced, /\.hud-c-spin\s*\{\s*animation: none/)
  assert.match(reduced, /\[data-attention-effect\] \.hud-c-urgent\s*\{\s*animation: none/)
  // Only loops stop; the morph between states keeps its transition.
  assert.doesNotMatch(reduced, /transition\s*:/)
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

test('only the settings window writes through the shell, and the compact preview is inert', () => {
  const app = readFileSync('apps/hud/src/renderer/src/App.tsx', 'utf8')
  assert.match(app, /if \(standaloneSettings\) void window\.codepulse\.setHudSettings\(patch\)/)
  assert.equal(app.match(/window\.codepulse\.setHudSettings/g)?.length, 1)
  assert.match(app, /ready=\{ready\}/)
  const preview = readFileSync('apps/hud/src/renderer/src/components/HudPreview.tsx', 'utf8')
  const compact = preview.slice(preview.indexOf("settings.hudStyle !== 'panel'"))
  const compactOnly = compact.slice(0, compact.indexOf('<fieldset'))
  assert.match(compactOnly, /role="group"/)
  assert.equal(compactOnly.match(/\{\.\.\.INERT\}/g)?.length, 2)
  assert.doesNotMatch(compactOnly, /<fieldset/)
})
