import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cleanupAgents, configureAgents } from '@codepulse/local-server'

test('agent auto configuration creates missing Claude and Codex config files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-agent-config-'))
  const hookBinDir = join(home, 'CodePulse App', 'resources', 'codepulse-hooks', 'bin')
  // Agent configs must point at stable ~/.codepulse/hooks/bin, not the install drive.
  const stableBin = join(home, '.codepulse', 'hooks', 'bin')

  const result = await configureAgents({ homeDir: home, hookBinDir })

  assert.equal(result.claude.changed, true)
  assert.equal(result.codex.changed, true)
  assert.equal(result.grok.changed, true)

  const runtime = JSON.parse(await readFile(join(home, '.codepulse', 'hook-runtime.json'), 'utf8'))
  assert.equal(runtime.hookBinDir, hookBinDir)
  assert.match(
    await readFile(join(stableBin, 'claude-statusline.js'), 'utf8'),
    /hook-runtime\.json/,
  )

  const claudeSettings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'))
  assert.equal(
    claudeSettings.hooks.SessionStart[0].hooks[0].command,
    `node "${join(stableBin, 'claude-hook.js')}"`,
  )
  assert.equal(
    claudeSettings.statusLine.command,
    `node "${join(stableBin, 'claude-statusline.js')}"`,
  )

  const codexHooks = JSON.parse(await readFile(join(home, '.codex', 'hooks.json'), 'utf8'))
  assert.equal(
    codexHooks.hooks.Stop[0].hooks[0].command,
    `node "${join(stableBin, 'codex-hook.js')}"`,
  )

  const codexConfig = await readFile(join(home, '.codex', 'config.toml'), 'utf8')
  assert.match(codexConfig, /\[features\][\s\S]*hooks = true/)

  const grokHooks = JSON.parse(
    await readFile(join(home, '.grok', 'hooks', 'codepulse.json'), 'utf8'),
  )
  assert.equal(
    grokHooks.hooks.Stop[0].hooks[0].command,
    `node "${join(stableBin, 'grok-hook.js')}"`,
  )
})

test('agent auto configuration is idempotent and preserves non-CodePulse hooks', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-agent-config-idempotent-'))
  const hookBinDir = join(home, 'CodePulse', 'hooks')
  const claudeDir = join(home, '.claude')
  const codexDir = join(home, '.codex')
  await mkdir(claudeDir, { recursive: true })
  await mkdir(codexDir, { recursive: true })

  await writeFile(
    join(claudeDir, 'settings.json'),
    JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node C:/old/CodePulse/packages/hooks/bin/claude-hook.js',
                },
                { type: 'command', command: 'echo keep-me' },
              ],
            },
          ],
        },
        statusLine: {
          type: 'command',
          command: 'node C:/old/CodePulse/packages/hooks/bin/claude-statusline.js',
        },
      },
      null,
      2,
    ),
    'utf8',
  )
  await writeFile(
    join(codexDir, 'hooks.json'),
    JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node C:/old/CodePulse/packages/hooks/bin/codex-hook.js',
                },
                { type: 'command', command: 'echo keep-me-too' },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
    'utf8',
  )
  await writeFile(join(codexDir, 'config.toml'), '[features]\nhooks = false\n', 'utf8')

  await configureAgents({ homeDir: home, hookBinDir })
  const second = await configureAgents({ homeDir: home, hookBinDir })

  assert.equal(second.claude.changed, false)
  assert.equal(second.codex.changed, false)

  const claudeSettings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'))
  const claudeStopHooks = claudeSettings.hooks.Stop[0].hooks.map(
    (hook: { command: string }) => hook.command,
  )
  const stableBin = join(home, '.codepulse', 'hooks', 'bin')
  assert.deepEqual(claudeStopHooks, [
    'echo keep-me',
    `node "${join(stableBin, 'claude-hook.js')}"`,
  ])
  assert.equal(
    claudeSettings.statusLine.command,
    `node "${join(stableBin, 'claude-statusline.js')}"`,
  )

  const codexHooks = JSON.parse(await readFile(join(codexDir, 'hooks.json'), 'utf8'))
  const codexStopHooks = codexHooks.hooks.Stop[0].hooks.map(
    (hook: { command: string }) => hook.command,
  )
  assert.deepEqual(codexStopHooks, [
    'echo keep-me-too',
    `node "${join(stableBin, 'codex-hook.js')}"`,
  ])

  const codexConfig = await readFile(join(codexDir, 'config.toml'), 'utf8')
  assert.match(codexConfig, /\[features\]\nhooks = true/)
})

test('Claude hook configuration does not append global hooks into matcher groups', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-agent-config-matcher-'))
  const hookBinDir = join(home, 'CodePulse', 'resources', 'codepulse-hooks', 'bin')
  const claudeDir = join(home, '.claude')
  await mkdir(claudeDir, { recursive: true })

  await writeFile(
    join(claudeDir, 'settings.json'),
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'echo bash-only' }],
            },
          ],
        },
      },
      null,
      2,
    ),
    'utf8',
  )

  await configureAgents({ homeDir: home, hookBinDir })

  const claudeSettings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'))
  const preToolUse = claudeSettings.hooks.PreToolUse
  assert.equal(preToolUse.length, 2)
  assert.deepEqual(
    preToolUse
      .find((group: { matcher?: string }) => group.matcher === 'Bash')
      .hooks.map((hook: { command: string }) => hook.command),
    ['echo bash-only'],
  )
  assert.equal(
    preToolUse.find((group: { matcher?: string }) => group.matcher == null).hooks[0].command,
    `node "${join(home, '.codepulse', 'hooks', 'bin', 'claude-hook.js')}"`,
  )
})

test('agent cleanup does not remove user hooks that only share CodePulse script names', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-agent-cleanup-own-hooks-'))
  const hookBinDir = join(home, 'CodePulse', 'resources', 'codepulse-hooks', 'bin')
  const claudeDir = join(home, '.claude')
  await mkdir(claudeDir, { recursive: true })

  await writeFile(
    join(claudeDir, 'settings.json'),
    JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'node D:/my/hooks/claude-hook.js' },
                {
                  type: 'command',
                  command: 'node D:/CodePulse/resources/codepulse-hooks/bin/claude-hook.js',
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
    'utf8',
  )

  await cleanupAgents({ homeDir: home, hookBinDir })

  const claudeSettings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'))
  assert.deepEqual(
    claudeSettings.hooks.Stop[0].hooks.map((hook: { command: string }) => hook.command),
    ['node D:/my/hooks/claude-hook.js'],
  )
})

test('agent cleanup removes CodePulse hooks while preserving user configuration', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-agent-cleanup-'))
  const hookBinDir = join(home, 'CodePulse', 'resources', 'codepulse-hooks', 'bin')
  const claudeDir = join(home, '.claude')
  const codexDir = join(home, '.codex')
  await mkdir(claudeDir, { recursive: true })
  await mkdir(codexDir, { recursive: true })

  await writeFile(
    join(claudeDir, 'settings.json'),
    JSON.stringify(
      {
        model: 'opus',
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node D:/CodePulse/resources/codepulse-hooks/bin/claude-hook.js',
                },
                { type: 'command', command: 'echo keep-claude' },
              ],
            },
          ],
        },
        statusLine: {
          type: 'command',
          command: 'node D:/CodePulse/resources/codepulse-hooks/bin/claude-statusline.js',
        },
      },
      null,
      2,
    ),
    'utf8',
  )
  await writeFile(
    join(codexDir, 'hooks.json'),
    JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node D:/CodePulse/resources/codepulse-hooks/bin/codex-hook.js',
                },
                { type: 'command', command: 'echo keep-codex' },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
    'utf8',
  )
  await writeFile(join(codexDir, 'config.toml'), '[features]\nhooks = true\n', 'utf8')

  const grokDir = join(home, '.grok', 'hooks')
  await mkdir(grokDir, { recursive: true })
  await writeFile(
    join(grokDir, 'codepulse.json'),
    JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node D:/CodePulse/resources/codepulse-hooks/bin/grok-hook.js',
                },
                { type: 'command', command: 'echo keep-grok' },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
    'utf8',
  )

  const result = await cleanupAgents({ homeDir: home, hookBinDir })

  assert.equal(result.claude.changed, true)
  assert.equal(result.codex.changed, true)
  assert.equal(result.grok.changed, true)

  const claudeSettings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'))
  assert.equal(claudeSettings.model, 'opus')
  assert.equal(claudeSettings.statusLine, undefined)
  assert.deepEqual(
    claudeSettings.hooks.Stop[0].hooks.map((hook: { command: string }) => hook.command),
    ['echo keep-claude'],
  )

  const codexHooks = JSON.parse(await readFile(join(codexDir, 'hooks.json'), 'utf8'))
  assert.deepEqual(
    codexHooks.hooks.Stop[0].hooks.map((hook: { command: string }) => hook.command),
    ['echo keep-codex'],
  )
  assert.match(await readFile(join(codexDir, 'config.toml'), 'utf8'), /hooks = true/)

  const grokHooks = JSON.parse(await readFile(join(grokDir, 'codepulse.json'), 'utf8'))
  assert.deepEqual(
    grokHooks.hooks.Stop[0].hooks.map((hook: { command: string }) => hook.command),
    ['echo keep-grok'],
  )
})

test('agent cleanup disables Codex hooks when only CodePulse hooks remain', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-agent-cleanup-empty-'))
  const codexDir = join(home, '.codex')
  await mkdir(codexDir, { recursive: true })
  await writeFile(
    join(codexDir, 'hooks.json'),
    JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node D:/CodePulse/resources/codepulse-hooks/bin/codex-hook.js',
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
    'utf8',
  )
  await writeFile(join(codexDir, 'config.toml'), '[features]\nhooks = true\n', 'utf8')

  await cleanupAgents({ homeDir: home, hookBinDir: join(home, 'hooks') })

  const codexHooks = JSON.parse(await readFile(join(codexDir, 'hooks.json'), 'utf8'))
  assert.equal(codexHooks.hooks, undefined)
  assert.match(await readFile(join(codexDir, 'config.toml'), 'utf8'), /hooks = false/)
})
