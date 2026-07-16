import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveEventWorkspacePaths, WorkspacePathResolver } from '@codepulse/local-server'

test('WorkspacePathResolver collapses a symlink or junction to its real project path', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-realpath-'))
  const project = join(home, 'project')
  const alias = join(home, 'project-alias')

  try {
    await mkdir(project)
    await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir')

    const resolver = new WorkspacePathResolver()
    const expected = await realpath(project)
    assert.equal(await resolver.resolve(alias), expected)

    const event = await resolveEventWorkspacePaths(
      {
        source: 'codex',
        eventType: 'session_start',
        workspacePath: alias,
        cwd: alias,
      },
      resolver,
    )
    assert.equal(event.workspacePath, expected)
    assert.equal(event.cwd, expected)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('WorkspacePathResolver caches successful lookups during event bursts', async () => {
  const path = join(tmpdir(), 'codepulse-cache-project')
  let calls = 0
  const resolver = new WorkspacePathResolver({
    resolveRealpath: async () => {
      calls += 1
      return path
    },
  })

  assert.equal(await resolver.resolve(path), path)
  assert.equal(await resolver.resolve(path), path)
  assert.equal(calls, 1)
})

test('WorkspacePathResolver shares concurrent lookups and bypasses relative paths', async () => {
  const path = join(tmpdir(), 'codepulse-concurrent-project')
  let calls = 0
  let release!: (value: string) => void
  const resolver = new WorkspacePathResolver({
    resolveRealpath: () => {
      calls += 1
      return new Promise<string>((resolve) => {
        release = resolve
      })
    },
  })

  const first = resolver.resolve(path)
  const second = resolver.resolve(path)
  await Promise.resolve()
  assert.equal(calls, 1)
  release(path)
  assert.deepEqual(await Promise.all([first, second]), [path, path])
  assert.equal(await resolver.resolve('relative/project'), 'relative/project')
  assert.equal(calls, 1)
})

test('WorkspacePathResolver caches a failed lookup briefly and retains the original path', async () => {
  const path = join(tmpdir(), 'codepulse-missing-project')
  let now = 1_000
  let calls = 0
  const resolver = new WorkspacePathResolver({
    now: () => now,
    resolveRealpath: (() => {
      calls += 1
      throw new Error('missing directory')
    }) as unknown as (path: string) => Promise<string>,
  })

  assert.equal(await resolver.resolve(path), path)
  assert.equal(await resolver.resolve(path), path)
  assert.equal(calls, 1)

  now += 1_001
  assert.equal(await resolver.resolve(path), path)
  assert.equal(calls, 2)
})
