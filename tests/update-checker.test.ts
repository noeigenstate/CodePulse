import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildDownloadCandidates,
  buildUpdateInfo,
  compareVersions,
  computeUpdateSnoozeUntil,
  isNewerVersion,
  isUpdateSnoozed,
  parseReleaseNotes,
  planByteRanges,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_SNOOZE_MS,
} from '../apps/desktop/src/main/update-checker.js'

test('update check policy is every 6h with 24h dismiss snooze', () => {
  assert.equal(UPDATE_CHECK_INTERVAL_MS, 6 * 60 * 60_000)
  assert.equal(UPDATE_SNOOZE_MS, 24 * 60 * 60_000)

  const now = 1_000_000_000_000
  const until = computeUpdateSnoozeUntil(now)
  assert.equal(until, now + UPDATE_SNOOZE_MS)
  assert.equal(isUpdateSnoozed(until, now), true)
  assert.equal(isUpdateSnoozed(until, now + UPDATE_SNOOZE_MS - 1), true)
  assert.equal(isUpdateSnoozed(until, now + UPDATE_SNOOZE_MS), false)
  assert.equal(isUpdateSnoozed(undefined, now), false)
  assert.equal(isUpdateSnoozed(NaN, now), false)
})

test('compareVersions handles multi-digit semver parts', () => {
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1)
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.2.0', '1.2.1'), -1)
})

test('isNewerVersion rejects equal, older, and malformed versions', () => {
  assert.equal(isNewerVersion('0.1.6', '0.1.5'), true)
  assert.equal(isNewerVersion('0.1.5', '0.1.5'), false)
  assert.equal(isNewerVersion('0.1.4', '0.1.5'), false)
  assert.equal(isNewerVersion('latest', '0.1.5'), false)
})

test('buildUpdateInfo selects the latest Windows installer asset', () => {
  const info = buildUpdateInfo(
    {
      tag_name: 'v0.1.6',
      html_url: 'https://github.com/noeigenstate/CodePulse/releases/tag/v0.1.6',
      body: '## v0.1.6\n\n### 更新内容\n\n- 修复更新下载\n- 优化界面\n',
      assets: [
        {
          name: 'CodePulse_0.1.6_x64-setup.exe.blockmap',
          browser_download_url: 'https://example.test/blockmap',
        },
        {
          name: 'CodePulse_0.1.6_x64-setup.exe',
          browser_download_url: 'https://example.test/installer',
        },
      ],
    },
    '0.1.5',
  )

  assert.deepEqual(info, {
    currentVersion: '0.1.5',
    version: '0.1.6',
    tag: 'v0.1.6',
    releaseUrl: 'https://github.com/noeigenstate/CodePulse/releases/tag/v0.1.6',
    installable: true,
    installerName: 'CodePulse_0.1.6_x64-setup.exe',
    installerUrl: 'https://example.test/installer',
    releaseNotes: ['修复更新下载', '优化界面'],
  })
})

test('parseReleaseNotes extracts markdown bullet lines', () => {
  assert.deepEqual(
    parseReleaseNotes(`## v1.0.2

### 更新内容

- 修复 Codex 额度显示
- 保留 **ffmpeg** 依赖
- 见 [文档](https://example.test)
`),
    ['修复 Codex 额度显示', '保留 ffmpeg 依赖', '见 文档'],
  )
  assert.deepEqual(parseReleaseNotes(''), [])
})

test('buildUpdateInfo returns null when release is not newer', () => {
  assert.equal(
    buildUpdateInfo(
      {
        tag_name: 'v0.1.5',
        html_url: 'https://github.com/noeigenstate/CodePulse/releases/tag/v0.1.5',
        assets: [
          {
            name: 'CodePulse_0.1.5_x64-setup.exe',
            browser_download_url: 'https://example.test/installer',
          },
        ],
      },
      '0.1.5',
    ),
    null,
  )
})

test('buildUpdateInfo still reports newer releases without a matching installer', () => {
  const info = buildUpdateInfo(
    {
      tag_name: 'v0.1.6',
      html_url: 'https://github.com/noeigenstate/CodePulse/releases/tag/v0.1.6',
      assets: [{ name: 'latest.yml', browser_download_url: 'https://example.test/latest.yml' }],
    },
    '0.1.5',
  )

  assert.equal(info?.releaseNotes, undefined)
  assert.deepEqual(info, {
    currentVersion: '0.1.5',
    version: '0.1.6',
    tag: 'v0.1.6',
    releaseUrl: 'https://github.com/noeigenstate/CodePulse/releases/tag/v0.1.6',
    installable: false,
    installerName: undefined,
    installerUrl: undefined,
  })
})

test('buildUpdateInfo does not auto-install mismatched installer assets', () => {
  const info = buildUpdateInfo(
    {
      tag_name: 'v0.1.6',
      html_url: 'https://github.com/noeigenstate/CodePulse/releases/tag/v0.1.6',
      assets: [
        {
          name: 'CodePulse_0.1.5_x64-setup.exe',
          browser_download_url: 'https://example.test/installer',
        },
      ],
    },
    '0.1.5',
  )

  assert.equal(info?.installable, false)
  assert.equal(info?.installerName, undefined)
  assert.equal(info?.installerUrl, undefined)
})

test('buildDownloadCandidates prefers GitHub mirrors before official URL', () => {
  const url =
    'https://github.com/noeigenstate/CodePulse/releases/download/v0.1.9/CodePulse_0.1.9_x64-setup.exe'
  const candidates = buildDownloadCandidates(url)
  assert.ok(candidates[0]?.includes('ghfast.top'))
  assert.ok(candidates.some((item) => item.includes('gh-proxy.com')))
  assert.equal(candidates.at(-1), url)
  assert.deepEqual(buildDownloadCandidates('https://example.test/app.exe'), [
    'https://example.test/app.exe',
  ])
})

test('planByteRanges covers the full installer without gaps or overlaps', () => {
  const total = 1_000_000
  const ranges = planByteRanges(total, 4)
  assert.equal(ranges.length, 4)
  assert.equal(ranges[0]?.start, 0)
  assert.equal(ranges.at(-1)?.end, total - 1)

  let cursor = 0
  for (const range of ranges) {
    assert.equal(range.start, cursor)
    assert.ok(range.end >= range.start)
    cursor = range.end + 1
  }
  assert.equal(cursor, total)
})
