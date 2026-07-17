import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  commandCandidates,
  detectClaudeAgent,
  detectCodexAgent,
  detectGrokAgent,
  detectKimiAgent,
} from '@codepulse/local-server'

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

test('Kimi detection probes its private install and main TOML hook config', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-kimi-detect-'))
  const kimiHome = join(home, '.kimi-code')
  await mkdir(kimiHome, { recursive: true })
  await writeFile(
    join(kimiHome, 'config.toml'),
    '[[hooks]]\nevent = "Stop"\ncommand = "node kimi-hook.js"\n',
    'utf8',
  )
  const commands: string[] = []
  const agent = await detectKimiAgent({
    homeDir: home,
    platform: 'win32',
    runCommand: async (command) => {
      commands.push(command)
      return { ok: true, stdout: '0.26.0' }
    },
  })

  assert.equal(commands[0], join(kimiHome, 'bin', 'kimi.exe'))
  assert.equal(agent.installed, true)
  assert.equal(agent.configured, true)
  assert.equal(agent.type, 'kimi')
  assert.equal(agent.version, '0.26.0')
})

test('macOS CLI candidates include Homebrew and bare command for GUI PATH gaps', async () => {
  const candidates = await commandCandidates('claude', {
    platform: 'darwin',
    homeDir: '/Users/demo',
    env: { PATH: '/usr/bin:/bin' },
  })

  assert.equal(candidates[0], 'claude')
  assert.ok(candidates.includes('/opt/homebrew/bin/claude'))
  assert.ok(candidates.includes('/usr/local/bin/claude'))
  assert.ok(candidates.includes('/Users/demo/.local/bin/claude'))
})

test('darwin detection finds CLI via absolute Homebrew path when bare name fails', async () => {
  const commands: string[] = []
  const agent = await detectCodexAgent({
    platform: 'darwin',
    homeDir: '/Users/demo',
    env: { PATH: '/usr/bin:/bin' },
    runCommand: async (command) => {
      commands.push(command)
      if (command === '/opt/homebrew/bin/codex') {
        return { ok: true, stdout: 'codex-cli 0.50.0' }
      }
      return { ok: false }
    },
  })

  assert.equal(agent.installed, true)
  assert.equal(agent.version, 'codex-cli 0.50.0')
  assert.ok(commands.includes('codex'))
  assert.ok(commands.includes('/opt/homebrew/bin/codex'))
})
