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
  assert.equal(result.kimi.changed, true)

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

  const kimiConfig = await readFile(join(home, '.kimi-code', 'config.toml'), 'utf8')
  assert.match(kimiConfig, /# >>> codepulse-managed >>>/)
  assert.match(kimiConfig, /event = "Stop"/)
  assert.match(kimiConfig, /kimi-hook\.js/)
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
  assert.equal(second.kimi.changed, false)

  const claudeSettings = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'))
  const claudeStopHooks = claudeSettings.hooks.Stop[0].hooks.map(
    (hook: { command: string }) => hook.command,
  )
  const stableBin = join(home, '.codepulse', 'hooks', 'bin')
  assert.deepEqual(claudeStopHooks, ['echo keep-me', `node "${join(stableBin, 'claude-hook.js')}"`])
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

test('Kimi configuration backup and cleanup preserve user TOML content', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-kimi-config-'))
  const kimiDir = join(home, '.kimi-code')
  const configPath = join(kimiDir, 'config.toml')
  const original = 'default_model = "kimi-code/k3"\n\n[thinking]\neffort = "max"\n'
  await mkdir(kimiDir, { recursive: true })
  await writeFile(configPath, original, 'utf8')

  const configured = await configureAgents({ homeDir: home, hookBinDir: join(home, 'hooks') })
  assert.equal(configured.kimi.changed, true)
  assert.equal(await readFile(`${configPath}.codepulse.bak`, 'utf8'), original)

  const cleaned = await cleanupAgents({ homeDir: home, hookBinDir: join(home, 'hooks') })
  assert.equal(cleaned.kimi.changed, true)
  assert.equal(await readFile(configPath, 'utf8'), original)
})

test('Kimi configuration migrates duplicate legacy CodePulse hook tables', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-kimi-config-legacy-'))
  const kimiDir = join(home, '.kimi-code')
  const configPath = join(kimiDir, 'config.toml')
  const legacyCommand = 'node "C:\\old\\CodePulse\\hooks\\bin\\kimi-hook.js"'
  const userCommand = 'node "C:/my-tools/kimi-hook.js"'
  const original = [
    'default_model = "kimi-code/k3"',
    '',
    '[[hooks]]',
    'event = "Stop"',
    `command = ${JSON.stringify(legacyCommand)}`,
    '',
    '[[hooks]]',
    'event = "Stop"',
    `command = ${JSON.stringify(legacyCommand)}`,
    '',
    '[[hooks]]',
    'event = "Stop"',
    'command = "echo keep-user-hook"',
    '',
    '[[hooks]]',
    'event = "Stop"',
    `command = ${JSON.stringify(userCommand)}`,
    '',
  ].join('\n')
  await mkdir(kimiDir, { recursive: true })
  await writeFile(configPath, original, 'utf8')

  const first = await configureAgents({ homeDir: home, hookBinDir: join(home, 'hooks') })
  const second = await configureAgents({ homeDir: home, hookBinDir: join(home, 'hooks') })
  const configured = await readFile(configPath, 'utf8')

  assert.equal(first.kimi.changed, true)
  assert.equal(second.kimi.changed, false)
  assert.equal((configured.match(/kimi-hook\.js/g) ?? []).length, 12)
  assert.equal((configured.match(/event = "Stop"/g) ?? []).length, 3)
  assert.match(configured, /echo keep-user-hook/)
  assert.ok(configured.includes(`command = ${JSON.stringify(userCommand)}`))

  const cleaned = await cleanupAgents({ homeDir: home, hookBinDir: join(home, 'hooks') })
  const afterCleanup = await readFile(configPath, 'utf8')
  assert.equal(cleaned.kimi.changed, true)
  assert.equal((afterCleanup.match(/kimi-hook\.js/g) ?? []).length, 1)
  assert.match(afterCleanup, /echo keep-user-hook/)
  assert.ok(afterCleanup.includes(`command = ${JSON.stringify(userCommand)}`))
})

test('agent cleanup restores untouched CLI configs byte-for-byte', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-agent-restore-'))
  const hookBinDir = join(home, 'CodePulse', 'hooks')
  const claudePath = join(home, '.claude', 'settings.json')
  const codexConfigPath = join(home, '.codex', 'config.toml')
  const kimiPath = join(home, '.kimi-code', 'config.toml')
  await mkdir(join(home, '.claude'), { recursive: true })
  await mkdir(join(home, '.codex'), { recursive: true })
  await mkdir(join(home, '.kimi-code'), { recursive: true })
  // Formatting JSON.stringify would not reproduce, to prove the bytes come back.
  const claudeOriginal =
    '{"model": "opus",\n    "statusLine": {"type":"command","command":"my-line"}}'
  const codexOriginal = 'model = "gpt-5"\r\n'
  const kimiOriginal = 'default_model = "k2"'
  await writeFile(claudePath, claudeOriginal)
  await writeFile(codexConfigPath, codexOriginal)
  await writeFile(kimiPath, kimiOriginal)

  await configureAgents({ homeDir: home, hookBinDir })
  await configureAgents({ homeDir: home, hookBinDir })
  assert.match(await readFile(claudePath, 'utf8'), /claude-hook\.js/)

  const result = await cleanupAgents({ homeDir: home, hookBinDir })

  for (const status of Object.values(result)) assert.equal(status.error, undefined)
  assert.equal(await readFile(claudePath, 'utf8'), claudeOriginal)
  assert.equal(await readFile(codexConfigPath, 'utf8'), codexOriginal)
  assert.equal(await readFile(kimiPath, 'utf8'), kimiOriginal)
  // Files CodePulse created are removed again.
  await assert.rejects(readFile(join(home, '.codex', 'hooks.json'), 'utf8'), { code: 'ENOENT' })
  await assert.rejects(readFile(join(home, '.grok', 'hooks', 'codepulse.json'), 'utf8'), {
    code: 'ENOENT',
  })
  await assert.rejects(readFile(join(home, '.codepulse', 'config-restore.json'), 'utf8'), {
    code: 'ENOENT',
  })
})

test('agent cleanup keeps user edits made after CodePulse configured the CLIs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-agent-restore-edited-'))
  const hookBinDir = join(home, 'CodePulse', 'hooks')
  const claudePath = join(home, '.claude', 'settings.json')
  const codexConfigPath = join(home, '.codex', 'config.toml')

  await configureAgents({ homeDir: home, hookBinDir })

  const claude = JSON.parse(await readFile(claudePath, 'utf8'))
  claude.model = 'sonnet'
  await writeFile(claudePath, JSON.stringify(claude))
  await writeFile(codexConfigPath, `model = "gpt-5"\n${await readFile(codexConfigPath, 'utf8')}`)

  await cleanupAgents({ homeDir: home, hookBinDir })

  assert.deepEqual(JSON.parse(await readFile(claudePath, 'utf8')), { model: 'sonnet' })
  assert.equal(await readFile(codexConfigPath, 'utf8'), 'model = "gpt-5"\n')
})

test('agent cleanup never rolls back edits made between two CodePulse writes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-agent-restore-between-'))
  const claudePath = join(home, '.claude', 'settings.json')
  await mkdir(join(home, '.claude'), { recursive: true })
  await writeFile(claudePath, '{"model":"opus"}\n')

  await configureAgents({ homeDir: home, hookBinDir: join(home, 'a') })
  const claude = JSON.parse(await readFile(claudePath, 'utf8'))
  claude.theme = 'dark'
  await writeFile(claudePath, JSON.stringify(claude))
  // A rewrite (new token / reformat) makes the user's edit part of CodePulse's write.
  await configureAgents({ homeDir: home, hookBinDir: join(home, 'b'), localAuthToken: 't' })

  await cleanupAgents({ homeDir: home, hookBinDir: join(home, 'b') })

  assert.deepEqual(JSON.parse(await readFile(claudePath, 'utf8')), {
    model: 'opus',
    theme: 'dark',
  })
})

test('agent cleanup restores the original Codex hooks feature flag', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-agent-restore-codex-'))
  const hookBinDir = join(home, 'CodePulse', 'hooks')
  const codexConfigPath = join(home, '.codex', 'config.toml')
  await mkdir(join(home, '.codex'), { recursive: true })
  await writeFile(codexConfigPath, '[features]\nhooks = false # off for now\n')

  await configureAgents({ homeDir: home, hookBinDir })
  assert.match(await readFile(codexConfigPath, 'utf8'), /hooks = true/)
  await writeFile(codexConfigPath, `${await readFile(codexConfigPath, 'utf8')}\n[tui]\nx = 1\n`)

  await cleanupAgents({ homeDir: home, hookBinDir })

  assert.equal(
    await readFile(codexConfigPath, 'utf8'),
    '[features]\nhooks = false # off for now\n\n[tui]\nx = 1\n',
  )
})
