import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  openDb,
  persistEvent,
  pruneEventsBefore,
  queryUsageStats,
  recentEvents,
  tokenSnapshots,
  turns,
} from '@codepulse/storage'

test('openDb and queryUsageStats heal legacy events schema without file_type_hints', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-storage-legacy-'))
  const file = join(home, 'legacy.sqlite')
  let opened: ReturnType<typeof openDb>
  try {
    // Create an old-shaped events table (pre-privacy column).
    const Database = (await import('better-sqlite3')).default
    const raw = new Database(file)
    raw.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        external_session_id TEXT,
        external_turn_id TEXT,
        workspace_path TEXT,
        model TEXT,
        tool_name TEXT,
        command TEXT,
        message TEXT,
        raw TEXT,
        timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      INSERT INTO events (id, source, event_type, tool_name, timestamp)
      VALUES ('e-legacy', 'codex', 'tool_start', 'Write path.ts', ${Date.now()});
    `)
    raw.close()

    opened = openDb(file)
  } catch (error) {
    await rm(home, { recursive: true, force: true })
    throw error
  }

  const { db, sqlite } = opened
  try {
    const cols = sqlite.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>
    assert.ok(
      cols.some((c) => c.name === 'file_type_hints'),
      'openDb must add file_type_hints to legacy events tables',
    )
    const stats = queryUsageStats(db, { range: '7d' }, Date.now(), { dbPath: file })
    assert.equal(stats.persistenceAvailable, true)
    assert.equal(stats.persistenceError, undefined)
  } finally {
    sqlite.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('pruneEventsBefore deletes old raw events and token snapshots', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-storage-prune-'))
  let opened: ReturnType<typeof openDb>
  try {
    opened = openDb(join(home, 'codepulse.sqlite'))
  } catch (error) {
    await rm(home, { recursive: true, force: true })
    throw error
  }
  const { db, sqlite } = opened

  try {
    persistEvent(db, {
      id: 'old-token',
      source: 'codex',
      eventType: 'token_snapshot',
      externalSessionId: 'session-a',
      cwd: 'E:/project/a',
      timestamp: 1_000,
      token: { input: 10, total: 10, accuracy: 'exact' },
    })
    persistEvent(db, {
      id: 'new-token',
      source: 'codex',
      eventType: 'token_snapshot',
      externalSessionId: 'session-a',
      cwd: 'E:/project/a',
      timestamp: 3_000,
      token: { input: 20, total: 20, accuracy: 'exact' },
    })

    pruneEventsBefore(db, 2_000)

    assert.deepEqual(
      recentEvents(db).map((event) => event.id),
      ['new-token'],
    )
    assert.deepEqual(
      db
        .select()
        .from(tokenSnapshots)
        .all()
        .map((snapshot) => snapshot.inputTokens),
      [20],
    )
  } finally {
    sqlite.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('persistEvent never stores complete hook payloads while previews and stats remain available', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-storage-privacy-'))
  let opened: ReturnType<typeof openDb>
  try {
    opened = openDb(join(home, 'codepulse.sqlite'))
  } catch (error) {
    await rm(home, { recursive: true, force: true })
    throw error
  }
  const { db, sqlite } = opened

  const now = Date.parse('2026-07-14T12:00:00')
  const secrets = {
    prompt: 'PROMPT_SECRET_does_not_belong_in_sqlite',
    toolInput: 'TOOL_INPUT_SECRET_does_not_belong_in_sqlite',
    toolResponse: 'TOOL_RESPONSE_SECRET_does_not_belong_in_sqlite',
    command: 'COMMAND_SECRET_does_not_belong_in_sqlite',
    env: 'ENV_SECRET_does_not_belong_in_sqlite',
    authorization: 'AUTHORIZATION_SECRET_does_not_belong_in_sqlite',
  }
  const promptMessage =
    `Review the local storage privacy boundary ${'prompt-body-'.repeat(20)}` + secrets.prompt
  const assistantMessage =
    `Privacy review completed ${'assistant-body-'.repeat(20)}` + secrets.toolResponse
  const sensitiveCommand =
    `node E:/private/${secrets.command}/source.ts && ` +
    `python E:/private/${secrets.env}/worker.py --authorization ${secrets.authorization}`
  const completeHookPayload = {
    hook_event_name: 'UserPromptSubmit',
    prompt: secrets.prompt,
    command: `run --token=${secrets.command}`,
    env: {
      PRIVATE_TOKEN: secrets.env,
    },
    authorization: `Bearer ${secrets.authorization}`,
    tool_input: {
      input: secrets.toolInput,
      nested: {
        command: secrets.command,
        environment: secrets.env,
      },
    },
    tool_response: {
      output: secrets.toolResponse,
      headers: {
        authorization: secrets.authorization,
      },
    },
  }

  try {
    persistEvent(db, {
      id: 'privacy-prompt',
      source: 'codex',
      eventType: 'prompt_submit',
      externalSessionId: 'privacy-session',
      externalTurnId: 'privacy-turn',
      workspacePath: 'E:/work/privacy-fixture',
      model: 'gpt-privacy-test',
      message: promptMessage,
      raw: completeHookPayload,
      timestamp: now - 3_000,
    })
    persistEvent(db, {
      id: 'privacy-tool',
      source: 'codex',
      eventType: 'tool_end',
      externalSessionId: 'privacy-session',
      externalTurnId: 'privacy-turn',
      workspacePath: 'E:/work/privacy-fixture',
      model: 'gpt-privacy-test',
      toolName: 'shell',
      command: sensitiveCommand,
      raw: completeHookPayload,
      token: {
        input: 30,
        output: 12,
        total: 42,
        accuracy: 'exact',
      },
      timestamp: now - 2_000,
    })
    persistEvent(db, {
      id: 'privacy-stop',
      source: 'codex',
      eventType: 'turn_stop',
      externalSessionId: 'privacy-session',
      externalTurnId: 'privacy-turn',
      workspacePath: 'E:/work/privacy-fixture',
      model: 'gpt-privacy-test',
      message: assistantMessage,
      raw: completeHookPayload,
      timestamp: now - 1_000,
    })

    const storedEvents = recentEvents(db, 10)
    assert.equal(storedEvents.length, 3)
    for (const event of storedEvents) {
      assert.equal(event.raw, null)
    }

    const promptEvent = storedEvents.find((event) => event.id === 'privacy-prompt')
    const toolEvent = storedEvents.find((event) => event.id === 'privacy-tool')
    const stopEvent = storedEvents.find((event) => event.id === 'privacy-stop')
    assertBoundedPreview(promptEvent?.message, 'Review the local storage privacy boundary')
    assertBoundedPreview(stopEvent?.message, 'Privacy review completed')
    assert.equal(toolEvent?.toolName, 'shell')
    assert.equal(toolEvent?.command, null)
    assertExtensionHintsOnly(toolEvent?.fileTypeHints, ['.ts', '.py'])

    const [storedTurn] = db.select().from(turns).all()
    assertBoundedPreview(storedTurn?.promptPreview, 'Review the local storage privacy boundary')
    assertBoundedPreview(storedTurn?.lastAssistantMessage, 'Privacy review completed')
    assert.equal(storedTurn?.state, 'DONE')

    const [storedToken] = db.select().from(tokenSnapshots).all()
    assert.equal(storedToken?.inputTokens, 30)
    assert.equal(storedToken?.outputTokens, 12)
    assert.equal(storedToken?.totalTokens, 42)

    const stats = queryUsageStats(db, { range: '7d' }, now)
    assert.equal(stats.hasData, true)
    assert.equal(stats.kpis.dialogCount, 1)
    assert.equal(stats.kpis.projectCount, 1)
    assert.equal(stats.kpis.totalTokens, 42)
    assert.equal(stats.fileTypes.find((item) => item.key === 'JavaScript')?.count, 1)
    assert.equal(stats.fileTypes.find((item) => item.key === 'Python')?.count, 1)

    const persistedSnapshot = JSON.stringify({
      events: storedEvents,
      turns: db.select().from(turns).all(),
      tokenSnapshots: db.select().from(tokenSnapshots).all(),
    })
    for (const secret of Object.values(secrets)) {
      assert.equal(
        persistedSnapshot.includes(secret),
        false,
        `SQLite retained sensitive value: ${secret}`,
      )
    }
  } finally {
    sqlite.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('openDb scrubs legacy raw hooks and commands without losing derived file types', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-storage-privacy-migration-'))
  const file = join(home, 'codepulse.sqlite')
  let active: ReturnType<typeof openDb> | undefined

  try {
    active = openDb(file)

    persistEvent(active.db, {
      id: 'legacy-private-event',
      source: 'codex',
      eventType: 'tool_end',
      externalSessionId: 'legacy-session',
      workspacePath: 'E:/work/legacy',
      timestamp: 10_000,
    })

    const legacySecret = 'LEGACY_RAW_SECRET_must_be_physically_removed'
    active.sqlite.exec(`
      DROP TRIGGER events_private_payload_insert_guard;
      DROP TRIGGER events_private_payload_update_guard;
      PRAGMA secure_delete = OFF;
      PRAGMA user_version = 0;
    `)
    active.sqlite
      .prepare('UPDATE events SET raw = ?, command = ? WHERE id = ?')
      .run(
        JSON.stringify({ prompt: legacySecret, tool_response: legacySecret }),
        `node E:/private/${legacySecret}/source.ts && python worker.py`,
        'legacy-private-event',
      )
    active.sqlite.close()
    active = undefined

    active = openDb(file)
    const migrated = active.sqlite
      .prepare('SELECT raw, command, file_type_hints AS fileTypeHints FROM events WHERE id = ?')
      .get('legacy-private-event') as {
      raw: string | null
      command: string | null
      fileTypeHints: string | null
    }
    assert.equal(migrated.raw, null)
    assert.equal(migrated.command, null)
    assertExtensionHintsOnly(migrated.fileTypeHints, ['.ts', '.py'])
    const migratedUserVersion = Number(active.sqlite.pragma('user_version', { simple: true }))
    assert.ok(migratedUserVersion > 0)
    assert.equal(Number(active.sqlite.pragma('secure_delete', { simple: true })), 1)
    assert.throws(
      () =>
        active!.sqlite
          .prepare('UPDATE events SET raw = ? WHERE id = ?')
          .run(legacySecret, 'legacy-private-event'),
      /private event payload persistence is disabled/,
    )
    active.sqlite.close()
    active = undefined

    // Reopening is intentionally part of the contract: the migration must be idempotent.
    active = openDb(file)
    assert.equal(
      Number(active.sqlite.pragma('user_version', { simple: true })),
      migratedUserVersion,
    )
    active.sqlite.close()
    active = undefined

    const secretBytes = Buffer.from(legacySecret)
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
      const bytes = await readFile(candidate).catch(() => undefined)
      if (bytes) {
        assert.equal(bytes.includes(secretBytes), false, `legacy secret remained in ${candidate}`)
      }
    }
  } finally {
    try {
      active?.sqlite.close()
    } catch {
      // already closed
    }
    await rm(home, { recursive: true, force: true })
  }
})

function assertBoundedPreview(value: string | null | undefined, expectedPrefix: string): void {
  assert.ok(value)
  assert.equal(value.startsWith(expectedPrefix), true)
  assert.ok(value.length <= 120, `preview exceeded 120 characters: ${value.length}`)
}

function assertExtensionHintsOnly(value: string | null | undefined, expected: string[]): void {
  assert.ok(value)
  const hints = value.split(/\s+/).filter(Boolean)
  assert.deepEqual(new Set(hints), new Set(expected))
  for (const hint of hints) {
    assert.match(hint, /^\.[a-z0-9]{1,8}$/i)
  }
}
