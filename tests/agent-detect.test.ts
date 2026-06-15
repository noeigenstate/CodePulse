import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectClaudeAgent, detectCodexAgent } from '@codepulse/local-server'

test('Claude detection falls back when the Windows cmd shim is broken', async () => {
  const commands: string[] = []
  const agent = await detectClaudeAgent({
    platform: 'win32',
    runCommand: async (command) => {
      commands.push(command)
      if (command === 'claude.cmd') return { ok: false }
      if (command === 'claude') return { ok: true, stdout: '2.1.177 (Claude Code)' }
      return { ok: false }
    },
  })

  assert.equal(agent.installed, true)
  assert.equal(agent.version, '2.1.177 (Claude Code)')
  assert.deepEqual(commands, ['claude.cmd', 'claude'])
})

test('Codex detection still probes the Windows cmd shim first', async () => {
  const commands: string[] = []
  await detectCodexAgent({
    platform: 'win32',
    runCommand: async (command) => {
      commands.push(command)
      return { ok: true, stdout: 'codex-cli 1.2.3' }
    },
  })

  assert.equal(commands[0], 'codex.cmd')
})
