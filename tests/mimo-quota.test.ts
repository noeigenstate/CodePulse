import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseMimoPlanDetail,
  parseMimoPlanUsedPercent,
  resolveMimoTokenPlanQuota,
  type MimoCookieRequest,
} from '../packages/local-server/src/mimo-quota.js'

const USAGE = {
  code: 0,
  data: {
    monthUsage: {
      percent: 0.25,
      items: [
        { name: 'month_total_token', used: 1_500_000, limit: 6_000_000, percent: 0.25 },
        { name: 'compensation_total_token', used: 0, limit: 1_000_000, percent: 0 },
      ],
    },
  },
}
const DETAIL = {
  code: 0,
  data: { planCode: 'standard', currentPeriodEnd: '2026-10-21 23:59:59', expired: false },
}

/** Builds a fetch fake that answers console endpoints for one accepted cookie. */
function consoleFetch(acceptedCookie: string, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const cookie = new Headers(init?.headers).get('cookie')
    calls.push(`${url.split('/api/v1/')[1]}:${cookie}`)
    if (cookie !== acceptedCookie) {
      return new Response(
        JSON.stringify({
          code: 401,
          loginUrl: 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform',
        }),
        { status: 401 },
      )
    }
    const body = url.endsWith('tokenPlan/usage') ? USAGE : DETAIL
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
}

test('parseMimoPlanUsedPercent reads the plan row, not compensation credits', () => {
  assert.equal(parseMimoPlanUsedPercent(USAGE), 25)
  // Falls back to the 0–1 fraction when used/limit are missing.
  assert.equal(
    parseMimoPlanUsedPercent({
      data: { monthUsage: { items: [{ name: 'plan_total_token', percent: '0.5' }] } },
    }),
    50,
  )
  assert.equal(parseMimoPlanUsedPercent({ code: 0, data: {} }), undefined)
})

test('parseMimoPlanDetail interprets currentPeriodEnd as Beijing time', () => {
  const detail = parseMimoPlanDetail(DETAIL)
  assert.equal(detail.planCode, 'standard')
  assert.equal(detail.resetsAt, Date.parse('2026-10-21T23:59:59+08:00') / 1000)
  assert.deepEqual(parseMimoPlanDetail(undefined), {})
})

test('resolveMimoTokenPlanQuota maps usage and reset into the plan window', async () => {
  const quota = await resolveMimoTokenPlanQuota({
    cookieProvider: async () => 'serviceToken=ok; userId=1',
    fetchImpl: consoleFetch('serviceToken=ok; userId=1'),
    now: () => 42,
  })
  assert.equal(quota?.rateLimits.sevenDay?.usedPercent, 25)
  assert.equal(quota?.rateLimits.sevenDay?.resetsAt, Date.parse('2026-10-21T23:59:59+08:00') / 1000)
  assert.equal(quota?.rateLimits.sevenDay?.windowMinutes, 31 * 24 * 60)
  assert.equal(quota?.planCode, 'standard')
  assert.equal(quota?.updatedAt, 42)
})

test('resolveMimoTokenPlanQuota renews an expired login once through the SSO URL', async () => {
  const requests: MimoCookieRequest[] = []
  const calls: string[] = []
  const quota = await resolveMimoTokenPlanQuota({
    cookieProvider: async (request) => {
      requests.push(request)
      return request.refresh ? 'serviceToken=new; userId=1' : 'serviceToken=old; userId=1'
    },
    fetchImpl: consoleFetch('serviceToken=new; userId=1', calls),
  })
  assert.equal(quota?.rateLimits.sevenDay?.usedPercent, 25)
  assert.deepEqual(requests, [
    { refresh: false },
    { refresh: true, loginUrl: 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform' },
  ])
  assert.ok(calls.some((call) => call === 'tokenPlan/usage:serviceToken=new; userId=1'))
})

test('resolveMimoTokenPlanQuota stays quiet when logged out or renewal fails', async () => {
  let fetched = false
  assert.equal(
    await resolveMimoTokenPlanQuota({
      cookieProvider: async () => undefined,
      fetchImpl: (async () => {
        fetched = true
        return new Response('{}')
      }) as typeof fetch,
    }),
    undefined,
  )
  assert.equal(fetched, false)
  assert.equal(
    await resolveMimoTokenPlanQuota({
      cookieProvider: async () => 'serviceToken=old; userId=1',
      fetchImpl: consoleFetch('serviceToken=never'),
    }),
    undefined,
  )
})
