import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TurnState } from '@codepulse/shared'
import {
  buildAgentPanels, buildWorkspaceAgentGroups, collectQuotaMeters, latestQuotaToken,
} from '../apps/hud/src/renderer/src/lib/displayAgents.js'

// Backend retention/acknowledgement is covered by the canonical host suites.
test('display panels collapse nested workspace cards into the project root', () => {
  const panels = buildAgentPanels([
    {
      agentType: 'claude_code',
      state: TurnState.DONE,
      toolCallCount: 1,
      needPermission: false,
      needUserInput: false,
      unread: false,
      lastEventAt: 100,
      workspacePath: 'E:/共形项目/zsy_pipe_network/gitlab_single_pipe',
    },
    {
      agentType: 'claude_code',
      state: TurnState.TOOL_RUNNING,
      toolCallCount: 2,
      needPermission: false,
      needUserInput: false,
      unread: false,
      lastEventAt: 200,
      workspacePath: 'E:/共形项目/zsy_pipe_network/gitlab_single_pipe/flow_pattern/results',
    },
    {
      agentType: 'claude_code',
      state: TurnState.TOOL_RUNNING,
      toolCallCount: 3,
      needPermission: false,
      needUserInput: false,
      unread: false,
      lastEventAt: 300,
      workspacePath: 'E:/共形项目/zsy_pipe_network/gitlab_single_pipe/flow_pattern_classifi',
    },
  ])

  assert.equal(panels.length, 1)
  assert.equal(panels[0]?.workspaces.length, 1)
  assert.equal(
    panels[0]?.workspaces[0]?.workspacePath,
    'E:/共形项目/zsy_pipe_network/gitlab_single_pipe',
  )
  assert.equal(panels[0]?.workspaces[0]?.agent.state, TurnState.TOOL_RUNNING)
  assert.equal(panels[0]?.workspaces[0]?.name, 'gitlab_single_pipe')
})


test('display panels keep an unread nested result visible ahead of newer active work', () => {
  const panels = buildAgentPanels([
    {
      agentType: 'codex',
      state: TurnState.TOOL_RUNNING,
      toolCallCount: 2,
      needPermission: false,
      needUserInput: false,
      unread: false,
      lastEventAt: 300,
      workspacePath: 'E:/project/root',
    },
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 1,
      needPermission: false,
      needUserInput: false,
      unread: true,
      lastEventAt: 200,
      workspacePath: 'E:/project/root/packages/worker',
    },
  ])

  assert.equal(panels[0]?.workspaces.length, 1)
  assert.equal(panels[0]?.workspaces[0]?.workspacePath, 'E:/project/root')
  assert.equal(panels[0]?.workspaces[0]?.agent.state, TurnState.DONE)
  assert.equal(panels[0]?.workspaces[0]?.agent.unread, true)
})


test('display panels expose pathless HUD alerts instead of leaving an unexplained orange tray', () => {
  const panels = buildAgentPanels([
    {
      agentType: 'grok',
      state: TurnState.ERROR,
      externalSessionId: 'pathless-session',
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      unread: true,
      lastEventAt: 200,
      activity: 'Task failed before cwd was reported',
    },
    {
      agentType: 'grok',
      state: TurnState.DONE,
      externalSessionId: 'second-pathless-session',
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      unread: true,
      lastEventAt: 300,
      activity: 'Second pathless task completed',
    },
  ])

  assert.equal(panels.length, 1)
  assert.equal(panels[0]?.workspaces.length, 1)
  assert.equal(panels[0]?.workspaces[0]?.workspacePath, undefined)
  assert.equal(panels[0]?.workspaces[0]?.agent.state, TurnState.ERROR)
})


test('display panels do not collapse Desktop projects under the user profile path', () => {
  const panels = buildAgentPanels([
    {
      agentType: 'codex',
      state: TurnState.IDLE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      unread: false,
      lastEventAt: 100,
      workspacePath: 'C:\\Users\\Administrator',
      model: 'gpt-5.6-sol',
    },
    {
      agentType: 'codex',
      state: TurnState.TOOL_RUNNING,
      toolCallCount: 2,
      needPermission: false,
      needUserInput: false,
      unread: false,
      lastEventAt: 500,
      workspacePath:
        'C:\\Users\\Administrator\\Desktop\\MetalMax_recovered_from_recycle_bin_20260708',
      model: 'gpt-5.6-sol',
    },
  ])

  assert.equal(panels.length, 1)
  const names = panels[0]?.workspaces.map((w) => w.name).sort() ?? []
  assert.deepEqual(names, ['Administrator', 'MetalMax_recovered_from_recycle_bin_20260708'])
  const metal = panels[0]?.workspaces.find((w) => w.name.startsWith('MetalMax'))
  assert.ok(metal)
  assert.match(
    metal?.workspacePath?.replace(/\\/g, '/') ?? '',
    /Desktop\/MetalMax_recovered_from_recycle_bin_20260708$/i,
  )
  assert.equal(metal?.agent.state, TurnState.TOOL_RUNNING)
})


test('display panels keep the newest verified model config for duplicate workspace sessions', () => {
  const panels = buildAgentPanels([
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      unread: false,
      externalSessionId: 'sol-session',
      workspacePath: 'E:/project/model-selection',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'max',
      modelObservedAt: 2_000,
      lastEventAt: 9_000,
    },
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      unread: false,
      externalSessionId: 'terra-session',
      workspacePath: 'E:/project/model-selection',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'ultra',
      modelObservedAt: 3_000,
      lastEventAt: 1_000,
    },
  ])

  const card = panels.find((panel) => panel.agentType === 'codex')?.workspaces[0]?.agent
  assert.equal(card?.model, 'gpt-5.6-terra')
  assert.equal(card?.reasoningEffort, 'ultra')
})


test('display agents are grouped by workspace with a shared token', () => {
  const groups = buildWorkspaceAgentGroups([
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 200,
      unread: true,
      workspacePath: 'E:/project/a',
      token: { total: 1200, contextUsedPercent: 12, accuracy: 'estimated' },
    },
    {
      agentType: 'claude_code',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 100,
      unread: true,
      workspacePath: 'E:/project/b',
      token: { total: 800, contextUsedPercent: 8, accuracy: 'exact' },
    },
  ])

  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map((group) => group.workspacePath).sort(), [
    'E:/project/a',
    'E:/project/b',
  ])
  assert.deepEqual(
    groups
      .flatMap((group) => group.agents.map((agent) => `${group.workspacePath}:${agent.agentType}`))
      .sort(),
    [
      'E:/project/a:claude_code',
      'E:/project/a:codex',
      'E:/project/a:grok',
      'E:/project/a:kimi',
      'E:/project/b:claude_code',
      'E:/project/b:codex',
      'E:/project/b:grok',
      'E:/project/b:kimi',
    ],
  )
  assert.equal(groups.find((group) => group.workspacePath === 'E:/project/a')?.token?.total, 1200)
})


test('display panels group slash and backslash variants into one project', () => {
  const panels = buildAgentPanels([
    {
      agentType: 'codex',
      state: TurnState.PROMPT_SUBMITTED,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'running',
      lastEventAt: 100,
      unread: false,
      workspacePath: 'E:\\project\\a',
    },
    {
      agentType: 'codex',
      state: TurnState.THINKING,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'thinking',
      lastEventAt: 200,
      unread: false,
      workspacePath: 'E:/project/a',
      token: { contextUsedPercent: 12, accuracy: 'estimated' },
    },
  ])

  const codexPanel = panels.find((panel) => panel.agentType === 'codex')
  assert.equal(codexPanel?.workspaces.length, 1)
  assert.equal(codexPanel?.workspaces[0]?.agent.token?.contextUsedPercent, 12)
})


test('display panels omit agent shells when there are no projects', () => {
  const panels = buildAgentPanels([])
  assert.equal(panels.length, 0)
})


test('display panels only include agents that have active projects', () => {
  const panels = buildAgentPanels([
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 200,
      unread: true,
      workspacePath: 'E:/project/a',
    },
    {
      agentType: 'grok',
      state: TurnState.THINKING,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'thinking',
      lastEventAt: 300,
      unread: false,
      workspacePath: 'E:/project/b',
    },
  ])

  assert.deepEqual(
    panels.map((panel) => panel.agentType),
    ['codex', 'grok'],
  )
  assert.equal(
    panels.find((panel) => panel.agentType === 'claude_code'),
    undefined,
  )
})


test('display panels keep quota-only agent after projects are hidden', () => {
  const panels = buildAgentPanels([
    {
      agentType: 'codex',
      state: TurnState.IDLE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      lastEventAt: 200,
      unread: false,
      taskHidden: true,
      workspacePath: 'E:/project/a',
      token: {
        accuracy: 'exact',
        rateLimits: {
          fiveHour: { usedPercent: 40, resetsAt: 1_000 },
          sevenDay: { usedPercent: 12 },
        },
      },
    },
  ])

  assert.equal(panels.length, 1)
  assert.equal(panels[0]?.agentType, 'codex')
  assert.equal(panels[0]?.workspaces.length, 0)
  assert.equal(panels[0]?.quotaToken?.rateLimits?.fiveHour?.usedPercent, 40)
})


test('display panels do not show pathless agents as unknown project cards', () => {
  const panels = buildAgentPanels([
    {
      agentType: 'claude_code',
      state: TurnState.IDLE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      lastEventAt: 300,
      unread: false,
      // No workspacePath — quota shell / probe event.
      token: {
        accuracy: 'estimated',
        rateLimits: {
          fiveHour: { usedPercent: 5, resetsAt: 2_000 },
          sevenDay: { usedPercent: 20, resetsAt: 9_000 },
        },
      },
    },
    {
      agentType: 'codex',
      state: TurnState.IDLE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      lastEventAt: 400,
      unread: false,
      token: {
        accuracy: 'estimated',
        rateLimits: {
          sevenDay: { usedPercent: 12, resetsAt: 9_000 },
        },
      },
    },
  ])

  const claude = panels.find((panel) => panel.agentType === 'claude_code')
  const codex = panels.find((panel) => panel.agentType === 'codex')
  assert.ok(claude, 'Claude pane kept for quota')
  assert.ok(codex, 'Codex pane kept for quota')
  assert.equal(claude?.workspaces.length, 0)
  assert.equal(codex?.workspaces.length, 0)
  assert.equal(claude?.quotaToken?.rateLimits?.fiveHour?.usedPercent, 5)
  assert.equal(codex?.quotaToken?.rateLimits?.sevenDay?.usedPercent, 12)
})


test('display panels keep Codex projects inside one panel', () => {
  const panels = buildAgentPanels([
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 200,
      unread: true,
      workspacePath: 'E:/project/a',
      token: { total: 1200, contextUsedPercent: 12, accuracy: 'estimated' },
    },
    {
      agentType: 'codex',
      state: TurnState.THINKING,
      toolCallCount: 1,
      needPermission: false,
      needUserInput: false,
      activity: 'thinking',
      lastEventAt: 300,
      unread: false,
      workspacePath: 'E:/project/b',
      token: {
        total: 800,
        contextUsedPercent: 8,
        rateLimits: { fiveHour: { usedPercent: 42 } },
        accuracy: 'estimated',
      },
    },
  ])

  const codexPanel = panels.find((panel) => panel.agentType === 'codex')
  assert.equal(codexPanel?.workspaces.length, 2)
  assert.deepEqual(codexPanel?.workspaces.map((item) => item.workspacePath).sort(), [
    'E:/project/a',
    'E:/project/b',
  ])
})


test('display panels keep Claude and Codex five-hour quotas separate', () => {
  const panels = buildAgentPanels([
    {
      agentType: 'claude_code',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 500,
      unread: false,
      workspacePath: 'E:/project/a',
      token: {
        contextUsedPercent: 40,
        rateLimits: {
          fiveHour: { usedPercent: 24, resetsAt: 1_000 },
          sevenDay: { usedPercent: 11 },
        },
        accuracy: 'exact',
      },
    },
    {
      agentType: 'codex',
      state: TurnState.THINKING,
      toolCallCount: 1,
      needPermission: false,
      needUserInput: false,
      activity: 'thinking',
      lastEventAt: 600,
      unread: true,
      workspacePath: 'E:/project/b',
      token: {
        contextUsedPercent: 12,
        rateLimits: {
          fiveHour: { usedPercent: 61, resetsAt: 2_000 },
          sevenDay: { usedPercent: 18 },
        },
        accuracy: 'estimated',
      },
    },
  ])

  const claudePanel = panels.find((panel) => panel.agentType === 'claude_code')
  const codexPanel = panels.find((panel) => panel.agentType === 'codex')

  assert.equal(claudePanel?.quotaToken?.rateLimits?.fiveHour?.usedPercent, 24)
  assert.equal(claudePanel?.quotaToken?.rateLimits?.fiveHour?.resetsAt, 1_000)
  assert.equal(codexPanel?.quotaToken?.rateLimits?.fiveHour?.usedPercent, 61)
  assert.equal(codexPanel?.quotaToken?.rateLimits?.fiveHour?.resetsAt, 2_000)
})


test('latest quota token uses the newest rate-limit payload', () => {
  const quota = latestQuotaToken([
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 100,
      unread: false,
      workspacePath: 'E:/project/a',
      token: {
        contextUsedPercent: 12,
        rateLimits: { fiveHour: { usedPercent: 12 } },
        accuracy: 'estimated',
      },
    },
    {
      agentType: 'claude_code',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 300,
      unread: false,
      workspacePath: 'E:/project/b',
      token: {
        contextUsedPercent: 8,
        rateLimits: { fiveHour: { usedPercent: 36 } },
        accuracy: 'exact',
      },
    },
  ])

  assert.equal(quota?.rateLimits?.fiveHour?.usedPercent, 36)
})


test('latest quota token prefers the active model quota when model sessions overlap', () => {
  const quota = latestQuotaToken(
    [
      {
        agentType: 'codex',
        state: TurnState.PROMPT_SUBMITTED,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 200,
        unread: false,
        workspacePath: 'E:/project/a',
        model: 'gpt-5.5',
        token: {
          contextUsedPercent: 12,
          rateLimits: { fiveHour: { usedPercent: 82 }, sevenDay: { usedPercent: 12 } },
          accuracy: 'estimated',
        },
      },
      {
        agentType: 'codex',
        state: TurnState.DONE,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'done',
        lastEventAt: 300,
        unread: false,
        workspacePath: 'E:/project/a',
        model: 'gpt-5.3-spark',
        token: {
          contextUsedPercent: 8,
          rateLimits: { fiveHour: { usedPercent: 2 }, sevenDay: { usedPercent: 1 } },
          accuracy: 'estimated',
        },
      },
    ],
    'gpt-5.5',
  )

  assert.equal(quota?.rateLimits?.fiveHour?.usedPercent, 82)
  assert.equal(quota?.rateLimits?.sevenDay?.usedPercent, 12)
})


test('collectQuotaMeters prefers higher same-window weekly % over active stale session', () => {
  const future = Math.floor(Date.now() / 1000) + 86_400
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.TOOL_RUNNING,
        toolCallCount: 1,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 900,
        unread: false,
        workspacePath: 'E:/work/active-stale',
        model: 'gpt-5.3-codex',
        token: {
          accuracy: 'estimated',
          rateLimitId: 'codex',
          rateLimits: {
            sevenDay: { usedPercent: 2, resetsAt: future, windowMinutes: 10_080 },
          },
        },
      },
      {
        agentType: 'codex',
        state: TurnState.IDLE,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        lastEventAt: 100,
        unread: false,
        workspacePath: 'E:/work/idle-correct',
        model: 'gpt-5.3-codex',
        token: {
          accuracy: 'estimated',
          rateLimitId: 'codex',
          rateLimits: {
            sevenDay: { usedPercent: 35, resetsAt: future, windowMinutes: 10_080 },
          },
        },
      },
    ],
    'codex',
  )

  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 35)
})


test('collectQuotaMeters prefers a newer weekly period over an older high percentage', () => {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.TOOL_RUNNING,
        toolCallCount: 1,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 200,
        unread: false,
        workspacePath: 'E:/work/old-period',
        model: 'gpt-5.3-codex',
        token: {
          accuracy: 'estimated',
          rateLimitId: 'codex',
          rateLimits: {
            sevenDay: {
              usedPercent: 82,
              resetsAt: nowSeconds + 86_400,
              windowMinutes: 10_080,
            },
          },
        },
      },
      {
        agentType: 'codex',
        state: TurnState.IDLE,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        lastEventAt: 100,
        unread: false,
        workspacePath: 'E:/work/new-period',
        model: 'gpt-5.3-codex',
        token: {
          accuracy: 'estimated',
          rateLimitId: 'codex',
          rateLimits: {
            sevenDay: {
              usedPercent: 5,
              resetsAt: nowSeconds + 6 * 86_400,
              windowMinutes: 10_080,
            },
          },
        },
      },
    ],
    'codex',
  )

  assert.equal(meters.length, 1)
  assert.equal(meters[0]?.id, 'codex')
  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 5)
})


test('collectQuotaMeters absorbs minor reset drift within one weekly period', () => {
  const futureSeconds = Math.floor(Date.now() / 1000) + 6 * 86_400
  // Straddle the old Math.round(... / 5 minutes) boundary by only two seconds.
  const resetAt = Math.floor(futureSeconds / 300) * 300 + 149
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.IDLE,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        lastEventAt: 100,
        unread: false,
        workspacePath: 'E:/work/reset-drift-high',
        model: 'gpt-5.3-codex',
        token: {
          accuracy: 'estimated',
          rateLimitId: 'codex',
          rateLimits: {
            sevenDay: { usedPercent: 35, resetsAt: resetAt, windowMinutes: 10_080 },
          },
        },
      },
      {
        agentType: 'codex',
        state: TurnState.IDLE,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        lastEventAt: 200,
        unread: false,
        workspacePath: 'E:/work/reset-drift-low',
        model: 'gpt-5.3-codex',
        token: {
          accuracy: 'estimated',
          rateLimitId: 'codex',
          rateLimits: {
            sevenDay: { usedPercent: 2, resetsAt: resetAt + 2, windowMinutes: 10_080 },
          },
        },
      },
    ],
    'codex',
  )

  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 35)
})


test('collectQuotaMeters keeps a soft-reset zero over an expired same-period high', () => {
  const expiredReset = Math.floor(Date.now() / 1000) - 60
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.TOOL_RUNNING,
        toolCallCount: 1,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 200,
        unread: false,
        workspacePath: 'E:/work/pre-reset-stale',
        model: 'gpt-5.3-codex',
        token: {
          accuracy: 'estimated',
          rateLimitId: 'codex',
          rateLimits: {
            sevenDay: { usedPercent: 82, resetsAt: expiredReset, windowMinutes: 10_080 },
          },
        },
      },
      {
        agentType: 'codex',
        state: TurnState.IDLE,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        lastEventAt: 100,
        unread: false,
        workspacePath: 'E:/work/post-reset-zero',
        model: 'gpt-5.3-codex',
        token: {
          accuracy: 'estimated',
          rateLimitId: 'codex',
          rateLimits: {
            sevenDay: { usedPercent: 0, resetsAt: expiredReset, windowMinutes: 10_080 },
          },
        },
      },
    ],
    'codex',
  )

  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 0)
})


test('collectQuotaMeters ignores hidden five-hour resets when choosing Codex weekly usage', () => {
  const weeklyReset = Math.floor(Date.now() / 1000) + 30 * 60
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.TOOL_RUNNING,
        toolCallCount: 1,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 200,
        unread: false,
        workspacePath: 'E:/work/five-hour-noise',
        model: 'gpt-5.3-codex',
        token: {
          accuracy: 'estimated',
          rateLimitId: 'codex',
          rateLimits: {
            fiveHour: { usedPercent: 1, resetsAt: weeklyReset + 4 * 3_600 },
            sevenDay: { usedPercent: 2, resetsAt: weeklyReset, windowMinutes: 10_080 },
          },
        },
      },
      {
        agentType: 'codex',
        state: TurnState.IDLE,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        lastEventAt: 100,
        unread: false,
        workspacePath: 'E:/work/weekly-authoritative',
        model: 'gpt-5.3-codex',
        token: {
          accuracy: 'estimated',
          rateLimitId: 'codex',
          rateLimits: {
            fiveHour: { usedPercent: 1, resetsAt: weeklyReset + 60 * 60 },
            sevenDay: { usedPercent: 35, resetsAt: weeklyReset, windowMinutes: 10_080 },
          },
        },
      },
    ],
    'codex',
  )

  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 35)
})


test('latest quota token selects the matching bucket when one token carries multiple Codex buckets', () => {
  const quota = latestQuotaToken(
    [
      {
        agentType: 'codex',
        state: TurnState.PROMPT_SUBMITTED,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 300,
        unread: false,
        workspacePath: 'E:/project/a',
        model: 'gpt-5.5',
        token: {
          rateLimitId: 'codex_bengalfox',
          rateLimitName: 'GPT-5.3-Codex-Spark',
          rateLimits: { fiveHour: { usedPercent: 2 }, sevenDay: { usedPercent: 1 } },
          quotaBuckets: {
            codex: {
              rateLimitId: 'codex',
              rateLimits: { fiveHour: { usedPercent: 78 }, sevenDay: { usedPercent: 16 } },
              updatedAt: 100,
            },
            codex_bengalfox: {
              rateLimitId: 'codex_bengalfox',
              rateLimitName: 'GPT-5.3-Codex-Spark',
              rateLimits: { fiveHour: { usedPercent: 2 }, sevenDay: { usedPercent: 1 } },
              updatedAt: 300,
            },
          },
          accuracy: 'estimated',
        },
      },
    ],
    'gpt-5.5',
  )

  assert.equal(quota?.rateLimitId, 'codex')
  assert.equal(quota?.rateLimits?.fiveHour?.usedPercent, 78)
  assert.equal(quota?.rateLimits?.sevenDay?.usedPercent, 16)
})


test('latest quota token ignores Spark-only payload while the active model is non-Spark', () => {
  const quota = latestQuotaToken(
    [
      {
        agentType: 'codex',
        state: TurnState.PROMPT_SUBMITTED,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 300,
        unread: false,
        workspacePath: 'E:/project/a',
        model: 'gpt-5.5',
        token: {
          rateLimitId: 'codex_bengalfox',
          rateLimitName: 'GPT-5.3-Codex-Spark',
          rateLimits: { fiveHour: { usedPercent: 2 }, sevenDay: { usedPercent: 1 } },
          accuracy: 'estimated',
        },
      },
    ],
    'gpt-5.5',
  )

  // No compatible non-Spark quota → nothing to show for this session model.
  assert.equal(quota, undefined)
})


test('latest quota token accepts Spark quota when the active Codex model is Spark', () => {
  const quota = latestQuotaToken(
    [
      {
        agentType: 'codex',
        state: TurnState.PROMPT_SUBMITTED,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 300,
        unread: false,
        workspacePath: 'E:/project/a',
        model: 'gpt-5.3-spark',
        token: {
          rateLimitId: 'codex_bengalfox',
          rateLimitName: 'GPT-5.3-Codex-Spark',
          rateLimits: { fiveHour: { usedPercent: 2 }, sevenDay: { usedPercent: 1 } },
          accuracy: 'estimated',
        },
      },
    ],
    'gpt-5.3-spark',
  )

  assert.equal(quota?.rateLimits?.fiveHour?.usedPercent, 2)
  assert.equal(quota?.rateLimits?.sevenDay?.usedPercent, 1)
})


test('collectQuotaMeters stacks default weekly and Spark only when both models are active', () => {
  const dualBuckets = {
    codex: {
      rateLimitId: 'codex',
      rateLimitName: 'Codex',
      rateLimits: {
        sevenDay: { usedPercent: 38, resetsAt: 1_000, windowMinutes: 10_080 },
      },
      updatedAt: 200,
    },
    codex_bengalfox: {
      rateLimitId: 'codex_bengalfox',
      rateLimitName: 'GPT-5.3-Codex-Spark',
      rateLimits: {
        sevenDay: { usedPercent: 0, resetsAt: 2_000, windowMinutes: 10_080 },
      },
      updatedAt: 300,
    },
  }
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.TOOL_RUNNING,
        toolCallCount: 1,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 200,
        unread: false,
        workspacePath: 'E:/project/a',
        model: 'gpt-5.5',
        token: {
          rateLimitId: 'codex',
          rateLimitName: 'Codex',
          rateLimits: { sevenDay: { usedPercent: 38, resetsAt: 1_000, windowMinutes: 10_080 } },
          quotaBuckets: dualBuckets,
          accuracy: 'estimated',
        },
      },
      {
        agentType: 'codex',
        state: TurnState.PROMPT_SUBMITTED,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 300,
        unread: false,
        workspacePath: 'E:/project/b',
        model: 'gpt-5.3-codex-spark',
        token: {
          rateLimitId: 'codex_bengalfox',
          rateLimitName: 'GPT-5.3-Codex-Spark',
          rateLimits: { sevenDay: { usedPercent: 0, resetsAt: 2_000, windowMinutes: 10_080 } },
          quotaBuckets: dualBuckets,
          accuracy: 'estimated',
        },
      },
    ],
    'codex',
  )

  assert.equal(meters.length, 2)
  assert.equal(meters[0]?.id, 'codex')
  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 38)
  assert.equal(meters[1]?.id, 'codex_bengalfox')
  assert.equal(meters[1]?.token.rateLimitName, 'GPT-5.3-Codex-Spark')
})


test('collectQuotaMeters hides Spark while an active non-Spark model is running (gpt-5.6-sol)', () => {
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.TOOL_RUNNING,
        toolCallCount: 1,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 500,
        unread: false,
        workspacePath: 'E:/project/metalmax',
        model: 'gpt-5.6-sol',
        token: {
          // Sticky Spark-only buckets must not become a second 每周额度 bar.
          rateLimitId: 'codex_bengalfox',
          rateLimitName: 'GPT-5.3-Codex-Spark',
          rateLimits: { sevenDay: { usedPercent: 0, resetsAt: 9_000, windowMinutes: 10_080 } },
          quotaBuckets: {
            codex: {
              rateLimitId: 'codex',
              rateLimitName: 'Codex',
              rateLimits: {
                sevenDay: { usedPercent: 43, resetsAt: 8_000, windowMinutes: 10_080 },
              },
              updatedAt: 400,
            },
            codex_bengalfox: {
              rateLimitId: 'codex_bengalfox',
              rateLimitName: 'GPT-5.3-Codex-Spark',
              rateLimits: {
                sevenDay: { usedPercent: 0, resetsAt: 9_000, windowMinutes: 10_080 },
              },
              updatedAt: 500,
            },
          },
          accuracy: 'estimated',
        },
      },
    ],
    'codex',
  )

  assert.equal(meters.length, 1)
  assert.equal(meters[0]?.id, 'codex')
  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 43)
  assert.doesNotMatch(
    `${meters[0]?.token.rateLimitId ?? ''} ${meters[0]?.token.rateLimitName ?? ''}`,
    /spark|bengalfox/i,
  )
})


test('collectQuotaMeters does not show twin weekly bars from Spark + default for non-Spark models', () => {
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.DONE,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'done',
        lastEventAt: 100,
        unread: false,
        workspacePath: 'E:/project/spark-old',
        model: 'gpt-5.3-codex-spark',
        token: {
          rateLimitId: 'codex_bengalfox',
          rateLimitName: 'GPT-5.3-Codex-Spark',
          rateLimits: { sevenDay: { usedPercent: 0, windowMinutes: 10_080 } },
          quotaBuckets: {
            codex: {
              rateLimitId: 'codex',
              rateLimits: { sevenDay: { usedPercent: 43, windowMinutes: 10_080 } },
              updatedAt: 50,
            },
            codex_bengalfox: {
              rateLimitId: 'codex_bengalfox',
              rateLimitName: 'GPT-5.3-Codex-Spark',
              rateLimits: { sevenDay: { usedPercent: 0, windowMinutes: 10_080 } },
              updatedAt: 100,
            },
          },
          accuracy: 'estimated',
        },
      },
      {
        agentType: 'codex',
        state: TurnState.TOOL_RUNNING,
        toolCallCount: 1,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 200,
        unread: false,
        workspacePath: 'E:/project/weekly-now',
        model: 'gpt-5.6-sol',
        token: {
          rateLimitId: 'codex',
          rateLimits: { sevenDay: { usedPercent: 43, windowMinutes: 10_080 } },
          quotaBuckets: {
            codex: {
              rateLimitId: 'codex',
              rateLimits: { sevenDay: { usedPercent: 43, windowMinutes: 10_080 } },
              updatedAt: 200,
            },
            codex_bengalfox: {
              rateLimitId: 'codex_bengalfox',
              rateLimitName: 'GPT-5.3-Codex-Spark',
              rateLimits: { sevenDay: { usedPercent: 0, windowMinutes: 10_080 } },
              updatedAt: 150,
            },
          },
          accuracy: 'estimated',
        },
      },
    ],
    'codex',
  )

  assert.equal(meters.length, 1)
  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 43)
})


test('collectQuotaMeters follows the latest model and hides stale Spark after switching to weekly models', () => {
  const dualBuckets = {
    codex: {
      rateLimitId: 'codex',
      rateLimitName: 'Codex',
      rateLimits: {
        sevenDay: { usedPercent: 42, resetsAt: 1_000, windowMinutes: 10_080 },
      },
      // Spark bucket was refreshed more recently by a previous turn — must not win.
      updatedAt: 100,
    },
    codex_bengalfox: {
      rateLimitId: 'codex_bengalfox',
      rateLimitName: 'GPT-5.3-Codex-Spark',
      rateLimits: {
        sevenDay: { usedPercent: 3, resetsAt: 2_000, windowMinutes: 10_080 },
      },
      updatedAt: 999,
    },
  }
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.DONE,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'done',
        lastEventAt: 100,
        unread: false,
        workspacePath: 'E:/project/old-spark',
        model: 'gpt-5.3-codex-spark',
        token: {
          rateLimitId: 'codex_bengalfox',
          rateLimitName: 'GPT-5.3-Codex-Spark',
          rateLimits: { sevenDay: { usedPercent: 3, windowMinutes: 10_080 } },
          quotaBuckets: dualBuckets,
          accuracy: 'estimated',
        },
      },
      {
        agentType: 'codex',
        state: TurnState.DONE,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'done',
        lastEventAt: 500,
        unread: false,
        workspacePath: 'E:/project/latest-weekly',
        model: 'gpt-5.6',
        token: {
          rateLimitId: 'codex',
          rateLimitName: 'Codex',
          rateLimits: { sevenDay: { usedPercent: 42, windowMinutes: 10_080 } },
          quotaBuckets: dualBuckets,
          accuracy: 'estimated',
        },
      },
    ],
    'codex',
  )

  assert.equal(meters.length, 1)
  assert.equal(meters[0]?.id, 'codex')
  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 42)
  assert.doesNotMatch(meters[0]?.token.rateLimitName ?? '', /Spark/i)
})


test('collectQuotaMeters shows only Spark weekly when only Spark was used', () => {
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.PROMPT_SUBMITTED,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 300,
        unread: false,
        workspacePath: 'E:/project/a',
        model: 'gpt-5.3-codex-spark',
        token: {
          rateLimitId: 'codex_bengalfox',
          rateLimitName: 'GPT-5.3-Codex-Spark',
          rateLimits: { sevenDay: { usedPercent: 5, windowMinutes: 10_080 } },
          quotaBuckets: {
            codex: {
              rateLimitId: 'codex',
              rateLimits: { sevenDay: { usedPercent: 40, windowMinutes: 10_080 } },
              updatedAt: 100,
            },
            codex_bengalfox: {
              rateLimitId: 'codex_bengalfox',
              rateLimitName: 'GPT-5.3-Codex-Spark',
              rateLimits: { sevenDay: { usedPercent: 5, windowMinutes: 10_080 } },
              updatedAt: 300,
            },
          },
          accuracy: 'estimated',
        },
      },
    ],
    'codex',
  )

  assert.equal(meters.length, 1)
  assert.equal(meters[0]?.id, 'codex_bengalfox')
  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 5)
})


test('collectQuotaMeters shows only default weekly for non-Spark gpt-5.3 models', () => {
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.PROMPT_SUBMITTED,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 300,
        unread: false,
        workspacePath: 'E:/project/a',
        model: 'gpt-5.3-codex',
        token: {
          rateLimitId: 'codex',
          rateLimits: { sevenDay: { usedPercent: 22, windowMinutes: 10_080 } },
          quotaBuckets: {
            codex: {
              rateLimitId: 'codex',
              rateLimits: { sevenDay: { usedPercent: 22, windowMinutes: 10_080 } },
              updatedAt: 300,
            },
            codex_bengalfox: {
              rateLimitId: 'codex_bengalfox',
              rateLimitName: 'GPT-5.3-Codex-Spark',
              rateLimits: { sevenDay: { usedPercent: 1, windowMinutes: 10_080 } },
              updatedAt: 100,
            },
          },
          accuracy: 'estimated',
        },
      },
    ],
    'codex',
  )

  assert.equal(meters.length, 1)
  assert.equal(meters[0]?.id, 'codex')
  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 22)
})


test('latest quota token prefers the freshest recent payload', () => {
  const quota = latestQuotaToken([
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 100,
      unread: false,
      workspacePath: 'E:/project/high',
      token: {
        contextUsedPercent: 12,
        rateLimits: {
          fiveHour: { usedPercent: 78, resetsAt: 1_000, windowMinutes: 300 },
          sevenDay: { usedPercent: 28, resetsAt: 2_000, windowMinutes: 10_080 },
        },
        accuracy: 'estimated',
      },
    },
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 200,
      unread: false,
      workspacePath: 'E:/project/zero',
      token: {
        contextUsedPercent: 8,
        rateLimits: {
          fiveHour: { usedPercent: 0, resetsAt: 3_000, windowMinutes: 300 },
          sevenDay: { usedPercent: 0, resetsAt: 4_000, windowMinutes: 10_080 },
        },
        accuracy: 'estimated',
      },
    },
  ])

  assert.equal(quota?.rateLimits?.fiveHour?.usedPercent, 0)
  assert.equal(quota?.rateLimits?.sevenDay?.usedPercent, 0)
})


test('latest quota token accepts fresh zero quota with reset metadata', () => {
  const quota = latestQuotaToken([
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 100,
      unread: false,
      workspacePath: 'E:/project/stale',
      token: {
        contextUsedPercent: 12,
        rateLimits: {
          fiveHour: { usedPercent: 78, resetsAt: 1_000, windowMinutes: 300 },
          sevenDay: { usedPercent: 28, resetsAt: 2_000, windowMinutes: 10_080 },
        },
        accuracy: 'estimated',
      },
    },
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 100 + 31 * 60_000,
      unread: false,
      workspacePath: 'E:/project/fresh',
      token: {
        contextUsedPercent: 8,
        rateLimits: {
          fiveHour: { usedPercent: 0, resetsAt: 3_000, windowMinutes: 300 },
          sevenDay: { usedPercent: 0, resetsAt: 4_000, windowMinutes: 10_080 },
        },
        accuracy: 'estimated',
      },
    },
  ])

  assert.equal(quota?.rateLimits?.fiveHour?.usedPercent, 0)
  assert.equal(quota?.rateLimits?.sevenDay?.usedPercent, 0)
})


test('latest quota token skips empty zero-only rate-limit payloads', () => {
  const quota = latestQuotaToken([
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 100,
      unread: false,
      workspacePath: 'E:/project/a',
      token: {
        contextUsedPercent: 12,
        rateLimits: {
          fiveHour: { usedPercent: 33, resetsAt: 1_000 },
          sevenDay: { usedPercent: 7, resetsAt: 2_000 },
        },
        accuracy: 'estimated',
      },
    },
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 300,
      unread: false,
      workspacePath: 'E:/project/b',
      token: {
        contextUsedPercent: 8,
        rateLimits: {
          fiveHour: { usedPercent: 0 },
          sevenDay: { usedPercent: 0 },
        },
        accuracy: 'estimated',
      },
    },
  ])

  assert.equal(quota?.rateLimits?.fiveHour?.usedPercent, 33)
  assert.equal(quota?.rateLimits?.sevenDay?.usedPercent, 7)
})
