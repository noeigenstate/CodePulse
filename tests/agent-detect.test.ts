import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { detectClaudeAgent, detectCodexAgent, detectGrokAgent } from '@codepulse/local-server'

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

test('Grok detection reports installed CLI and CodePulse hook file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-grok-detect-'))
  const hooksDir = join(home, '.grok', 'hooks')
  await mkdir(hooksDir, { recursive: true })
  await writeFile(
    join(hooksDir, 'codepulse.json'),
    JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: 'node E:/repo/packages/hooks/bin/grok-hook.js',
              },
            ],
          },
        ],
      },
    }),
    'utf8',
  )

  const agent = await detectGrokAgent({
    homeDir: home,
    platform: 'win32',
    runCommand: async () => ({ ok: true, stdout: 'grok 0.2.100' }),
  })

  assert.equal(agent.installed, true)
  assert.equal(agent.configured, true)
  assert.equal(agent.type, 'grok')
  assert.equal(agent.version, 'grok 0.2.100')
})
