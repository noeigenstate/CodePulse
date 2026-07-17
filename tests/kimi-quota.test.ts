import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import {
  fetchKimiManagedUsage,
  normalizeKimiManagedUsage,
} from '../packages/local-server/src/kimi-quota.js'

const PAYLOAD = {
  usage: {
    limit: '100',
    used: '20',
    remaining: '80',
    resetTime: '2026-07-24T01:49:04.846851Z',
  },
  limits: [
    {
      window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: {
        limit: '100',
        used: '100',
        resetTime: '2026-07-17T06:49:04.846851Z',
      },
    },
  ],
}

test('normalizeKimiManagedUsage maps CLI weekly and five-hour windows', () => {
  const quota = normalizeKimiManagedUsage(PAYLOAD)
  assert.deepEqual(quota, {
    fiveHour: {
      usedPercent: 100,
      resetsAt: Math.floor(Date.parse('2026-07-17T06:49:04.846851Z') / 1000),
      windowMinutes: 300,
    },
    sevenDay: {
      usedPercent: 20,
      resetsAt: Math.floor(Date.parse('2026-07-24T01:49:04.846851Z') / 1000),
      windowMinutes: 10_080,
    },
  })
})

test('fetchKimiManagedUsage reads OAuth locally without exposing it in the result', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-kimi-quota-'))
  const credentialsDir = join(home, 'credentials')
  await mkdir(credentialsDir, { recursive: true })
  await writeFile(
    join(credentialsDir, 'kimi-code.json'),
    JSON.stringify({ access_token: 'secret-access-token-that-is-long-enough' }),
    'utf8',
  )

  let authorization = ''
  try {
    const quota = await fetchKimiManagedUsage({
      kimiHome: home,
      fetchImpl: async (_input, init) => {
        authorization = new Headers(init?.headers).get('authorization') ?? ''
        return new Response(JSON.stringify(PAYLOAD), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    assert.equal(authorization, 'Bearer secret-access-token-that-is-long-enough')
    assert.equal(quota?.fiveHour?.usedPercent, 100)
    assert.equal(quota?.sevenDay?.usedPercent, 20)
    assert.equal(JSON.stringify(quota).includes('secret-access-token'), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
