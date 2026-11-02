import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_WORK_VOICE,
  TurnState,
  type AgentRuntimeState,
  type UiLocale,
} from '@codepulse/shared'
import { WorkVoice } from '../apps/desktop/src/main/work-voice.js'
import {
  normalizeWorkVoice,
  readWorkVoice,
  writeWorkVoice,
} from '../apps/desktop/src/main/work-voice-settings.js'

function fixture(enabled = true, supported = true) {
  let now = 1000,
    cancelled = 0
  const timers = new Set<{ callback: () => void; at: number }>()
  const spoken: { text: string; locale: UiLocale }[] = []
  const validities: (() => boolean)[] = []
  const voice = new WorkVoice(
    { ...DEFAULT_WORK_VOICE, enabled },
    {
      now: () => now,
      supported,
      speak: async (text, locale, valid) => {
        spoken.push({ text, locale })
        validities.push(valid)
      },
      cancel: () => {
        cancelled++
      },
      schedule(callback, ms) {
        const timer = { callback, at: now + ms }
        timers.add(timer)
        return () => {
          timers.delete(timer)
        }
      },
    },
  )
  const agent = (
    state: AgentRuntimeState['state'],
    patch: Partial<AgentRuntimeState> = {},
  ): AgentRuntimeState => ({
    agentType: 'codex',
    state,
    workspacePath: 'C:/private-project',
    externalSessionId: 'session',
    externalTurnId: 'turn',
    toolCallCount: 0,
    needPermission: false,
    needUserInput: false,
    unread: true,
    lastEventAt: now,
    ...patch,
  })
  const observe = (...agents: AgentRuntimeState[]) =>
    voice.observe({ overall: 'idle', agents, updatedAt: now })
  const advance = async (ms: number) => {
    now += ms
    for (const timer of [...timers])
      if (timer.at <= now) {
        timers.delete(timer)
        timer.callback()
      }
    await Promise.resolve()
    await Promise.resolve()
  }
  observe()
  return {
    voice,
    agent,
    observe,
    advance,
    spoken,
    validities,
    timers,
    get cancelled() {
      return cancelled
    },
  }
}

test('speech is off by default and settings persist strictly without leaking text', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'codepulse-voice-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'voice.json')
  assert.deepEqual(readWorkVoice(path), DEFAULT_WORK_VOICE)
  for (const value of ['null', '[]', 'bad', '{"enabled":"true"}']) {
    writeFileSync(path, value)
    assert.equal(readWorkVoice(path).enabled, false)
  }
  assert.equal(normalizeWorkVoice({ enabled: 1 }).enabled, false)
  const settings = writeWorkVoice(path, {
    enabled: true,
    intervention: false,
    failures: true,
    text: 'PRIVATE',
  })
  assert.deepEqual(readWorkVoice(path), settings)
  assert.equal(readFileSync(path, 'utf8').includes('PRIVATE'), false)
})

test('startup history, missing voices and disabled speech never announce', async () => {
  for (const [enabled, supported] of [
    [true, true],
    [false, true],
    [true, false],
  ]) {
    const f = fixture(enabled, supported)
    f.observe(f.agent(TurnState.WAITING_PERMISSION))
    await f.advance(11_000)
    f.observe(f.agent(TurnState.WAITING_PERMISSION))
    await f.advance(5000)
    assert.equal(f.spoken.length, 0)
    f.voice.close()
  }
})

test('new intervention is stable and private; each waiting episode can alert after progress', async () => {
  const f = fixture()
  await f.advance(11_000)
  f.observe(f.agent(TurnState.WAITING_PERMISSION, { activity: 'PRIVATE SECRET COMMAND' }))
  await f.advance(1999)
  assert.equal(f.spoken.length, 0)
  await f.advance(1)
  assert.equal(f.spoken.length, 1)
  assert.match(f.spoken[0]!.text, /授权/)
  assert.doesNotMatch(f.spoken[0]!.text, /PRIVATE|private-project/)
  f.observe(f.agent(TurnState.WAITING_PERMISSION))
  await f.advance(70_000)
  f.observe(f.agent(TurnState.THINKING))
  f.observe(f.agent(TurnState.WAITING_PERMISSION))
  await f.advance(3000)
  assert.equal(f.spoken.length, 2, 'a new manual approval in the same turn can speak again')
  assert.equal(
    f.validities[0]!(),
    false,
    'old device clips remain invalid during a later waiting episode',
  )
  f.observe(f.agent(TurnState.WAITING_PERMISSION, { externalTurnId: 'next-turn' }))
  await f.advance(2000)
  assert.equal(f.spoken.length, 2, 'new turns still respect the global cooldown')
  await f.advance(58000)
  assert.equal(f.spoken.length, 3)
  f.voice.close()
})

test('resolved, read, hidden and transient problems are dropped before speaking', async () => {
  const f = fixture()
  await f.advance(11_000)
  f.observe(f.agent(TurnState.WAITING_USER_INPUT))
  await f.advance(1000)
  f.observe(f.agent(TurnState.THINKING))
  await f.advance(1000)
  f.observe(f.agent(TurnState.ERROR, { unread: false }))
  f.observe(f.agent(TurnState.ERROR, { taskHidden: true }))
  await f.advance(3000)
  assert.equal(f.spoken.length, 0)
  f.voice.close()
})

test('multiple sessions batch, cooldown retains only unresolved fresh alerts', async () => {
  const f = fixture()
  await f.advance(11_000)
  f.observe(
    f.agent(TurnState.ERROR),
    f.agent(TurnState.WAITING_USER_INPUT, { externalSessionId: 'other' }),
  )
  await f.advance(2000)
  assert.match(f.spoken[0]!.text, /2 个任务/)
  f.observe(f.agent(TurnState.WAITING_PERMISSION, { externalSessionId: 'third' }))
  await f.advance(59_000)
  assert.equal(f.spoken.length, 1)
  await f.advance(1000)
  assert.equal(f.spoken.length, 2)
  f.observe(f.agent(TurnState.ERROR, { externalSessionId: 'fourth' }))
  await f.advance(121_000)
  assert.equal(f.spoken.length, 2)
  f.voice.close()
})

test('enabling does not replay pending tasks and category toggles are independent', async () => {
  const f = fixture(false)
  await f.advance(11_000)
  f.observe(f.agent(TurnState.WAITING_PERMISSION))
  f.voice.configure({ enabled: true, intervention: false, failures: true })
  f.observe(f.agent(TurnState.WAITING_PERMISSION))
  await f.advance(2000)
  assert.equal(f.spoken.length, 0)
  f.observe(f.agent(TurnState.ERROR))
  await f.advance(2000)
  assert.match(f.spoken[0]!.text, /执行失败/)
  f.voice.configure({ enabled: true, intervention: true, failures: false })
  f.observe(f.agent(TurnState.TIMEOUT))
  await f.advance(61_000)
  assert.equal(f.spoken.length, 1)
  f.observe(f.agent(TurnState.WAITING_USER_INPUT))
  await f.advance(2000)
  assert.match(f.spoken[1]!.text, /补充信息/)
  f.voice.close()
})

test('cancel/disable stops the owned speaker and pending work; preview works while off', async () => {
  const f = fixture(false)
  await f.voice.test('en')
  assert.match(f.spoken[0]!.text, /voice is ready/)
  assert.equal(f.spoken[0]!.locale, 'en')
  f.voice.configure({ ...DEFAULT_WORK_VOICE, enabled: true })
  await f.advance(61_000)
  f.observe(f.agent(TurnState.ERROR))
  f.voice.configure(DEFAULT_WORK_VOICE)
  await f.advance(3000)
  assert.equal(f.spoken.length, 1)
  assert.ok(f.cancelled > 0)
  f.voice.close()
  assert.equal(f.timers.size, 0)
})

test('completion/cancel/working states stay silent; language and fault reasons differ', async () => {
  const f = fixture()
  await f.advance(11_000)
  for (const state of [
    TurnState.DONE,
    TurnState.CANCELLED,
    TurnState.TOOL_RUNNING,
    TurnState.IDLE,
  ]) {
    f.observe(f.agent(state))
    await f.advance(3000)
  }
  assert.equal(f.spoken.length, 0)
  f.voice.setLocale('en')
  f.observe(f.agent(TurnState.TIMEOUT))
  await f.advance(2000)
  assert.match(f.spoken[0]!.text, /may be stuck/)
  f.observe(f.agent(TurnState.USAGE_LIMITED))
  await f.advance(60_000)
  assert.match(f.spoken[1]!.text, /usage limit/)
  f.voice.close()
})

test('failed playback is visible and never creates an automatic retry loop', async () => {
  let callbacks: (() => void)[] = [],
    now = 0,
    attempts = 0
  const voice = new WorkVoice(
    { ...DEFAULT_WORK_VOICE, enabled: true },
    {
      supported: true,
      now: () => now,
      cancel() {},
      speak: async () => {
        attempts++
        throw Error('not installed')
      },
      schedule: (callback) => {
        callbacks.push(callback)
        return () => {
          callbacks = []
        }
      },
    },
  )
  voice.observe({ overall: 'idle', agents: [], updatedAt: 0 })
  now = 11_000
  const a: AgentRuntimeState = {
    agentType: 'claude_code',
    state: TurnState.ERROR,
    lastEventAt: now,
    unread: true,
    toolCallCount: 0,
    needPermission: false,
    needUserInput: false,
  }
  voice.observe({ overall: 'error', agents: [a], updatedAt: now })
  now += 2000
  callbacks.shift()!()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(voice.snapshot().error, 'failed')
  assert.equal(attempts, 1)
  voice.observe({ overall: 'error', agents: [a], updatedAt: now })
  assert.equal(callbacks.length, 0)
  voice.close()
})
