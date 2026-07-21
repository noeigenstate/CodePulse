import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toDeviceStatusV1 } from '@codepulse/core'
import {
  DEVICE_PROTOCOL_VERSION,
  TurnState,
  type AgentRuntimeState,
  type StatusSnapshot,
} from '@codepulse/shared'

test('device protocol v1 projects display data without exposing absolute paths', () => {
  const snapshot = exampleSnapshot()
  const device = toDeviceStatusV1(snapshot)

  assert.equal(device.protocolVersion, DEVICE_PROTOCOL_VERSION)
  assert.equal(device.mainState, 'waiting_permission')
  assert.equal(device.activeAgent, 'claude_code')
  assert.equal(device.message, '等待授权')
  assert.equal(device.updatedAt, 2_000)
  assert.match(device.revision, /^v1-[0-9a-f]{8}$/)
  assert.deepEqual(
    device.agents.map((agent) => agent.type),
    ['codex', 'claude_code'],
  )

  const codex = device.agents[0]
  assert.equal(codex?.state, 'tool_running')
  assert.equal(codex?.project, 'desktop')
  assert.equal(codex?.activity, '运行 desktop/scripts/test.sh')
  assert.equal(codex?.tokens.input, 120)
  assert.equal(codex?.tokens.cachedInput, 20)
  assert.equal(codex?.tokens.total, 150)
  assert.equal(codex?.tokens.contextUsedPercent, 42.35)
  assert.deepEqual(
    codex?.quotas.map((quota) => quota.id),
    ['codex', 'codex_spark'],
  )
  assert.equal(codex?.quotas[0]?.fiveHour?.resetsAt, 2_000_000_000)
  assert.equal(codex?.quotas[1]?.weekly?.resetsAt, 2_100_000_000)
  assert.equal(JSON.stringify(device).includes('/Users/example/secret'), false)

  const claude = device.agents[1]
  assert.equal(claude?.state, 'waiting_permission')
  assert.equal(claude?.needsAttention, true)
})

test('device revision ignores timestamps but changes with display data', () => {
  const snapshot = exampleSnapshot()
  const initial = toDeviceStatusV1(snapshot)
  const timestampOnly = toDeviceStatusV1({
    ...snapshot,
    updatedAt: snapshot.updatedAt + 5_000,
    agents: snapshot.agents.map((agent) => ({
      ...agent,
      lastEventAt: agent.lastEventAt + 5_000,
    })),
  })

  assert.equal(timestampOnly.revision, initial.revision)
  assert.notEqual(timestampOnly.updatedAt, initial.updatedAt)

  const tokenChanged = toDeviceStatusV1({
    ...snapshot,
    agents: snapshot.agents.map((agent) =>
      agent.agentType === 'codex' ? { ...agent, token: { ...agent.token!, total: 151 } } : agent,
    ),
  })
  assert.notEqual(tokenChanged.revision, initial.revision)
})

test('device protocol retains account quota after an expired task is hidden', () => {
  const hidden: AgentRuntimeState = {
    agentType: 'grok',
    state: TurnState.DONE,
    workspacePath: '/private/work/project',
    toolCallCount: 0,
    needPermission: false,
    needUserInput: false,
    token: {
      accuracy: 'exact',
      rateLimitId: 'grok',
      rateLimits: { sevenDay: { usedPercent: 17, resetsAt: 2_200_000_000 } },
    },
    lastEventAt: 3_000,
    taskHidden: true,
    unread: false,
  }

  const device = toDeviceStatusV1({ overall: 'idle', agents: [hidden], updatedAt: 9_000 })
  assert.equal(device.activeAgent, null)
  assert.equal(device.agents[0]?.state, 'idle')
  assert.equal(device.agents[0]?.project, null)
  assert.equal(device.agents[0]?.quotas[0]?.weekly?.usedPercent, 17)
})

function exampleSnapshot(): StatusSnapshot {
  return {
    overall: 'attention',
    updatedAt: 9_999,
    agents: [
      {
        agentType: 'codex',
        state: TurnState.TOOL_RUNNING,
        workspacePath: '/Users/example/secret/desktop',
        model: 'gpt-5.4',
        activity: '运行 /Users/example/secret/desktop/scripts/test.sh',
        toolCallCount: 2,
        needPermission: false,
        needUserInput: false,
        token: {
          input: 120,
          cachedInput: 20,
          output: 30,
          total: 150,
          contextUsedPercent: 42.345,
          contextWindow: 258_400,
          accuracy: 'exact',
          rateLimitId: 'codex',
          rateLimitName: 'Codex',
          rateLimits: {
            fiveHour: { usedPercent: 23, resetsAt: 2_000_000_000, windowMinutes: 300 },
          },
          quotaBuckets: {
            spark: {
              rateLimitId: 'codex_spark',
              rateLimitName: 'Codex Spark',
              rateLimits: {
                sevenDay: {
                  usedPercent: 9,
                  resetsAt: 2_100_000_000_000,
                  windowMinutes: 10_080,
                },
              },
              updatedAt: 1_500,
            },
          },
        },
        lastEventAt: 1_000,
        unread: false,
      },
      {
        agentType: 'claude_code',
        state: TurnState.WAITING_PERMISSION,
        workspacePath: 'C:\\work\\api',
        activity: '等待授权',
        toolCallCount: 1,
        needPermission: true,
        needUserInput: false,
        lastEventAt: 2_000,
        unread: false,
      },
    ],
  }
}
