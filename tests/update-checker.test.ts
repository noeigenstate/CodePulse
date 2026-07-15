import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildDownloadCandidates,
  buildUpdateInfo,
  compareVersions,
  isAllowedUpdateUrl,
  isNewerVersion,
  parseReleaseNotes,
  parseSha256Digest,
  planByteRanges,
} from '../apps/desktop/src/main/update-checker.js'

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
  const installerUrl =
    'https://github.com/noeigenstate/CodePulse/releases/download/v0.1.6/CodePulse_0.1.6_x64-setup.exe'
  const info = buildUpdateInfo(
    {
      tag_name: 'v0.1.6',
      html_url: 'https://github.com/noeigenstate/CodePulse/releases/tag/v0.1.6',
      body: '## v0.1.6\n\n### 更新内容\n\n- 修复更新下载\n- 优化界面\n',
      assets: [
        {
          name: 'CodePulse_0.1.6_x64-setup.exe.blockmap',
          browser_download_url:
            'https://github.com/noeigenstate/CodePulse/releases/download/v0.1.6/CodePulse_0.1.6_x64-setup.exe.blockmap',
        },
        {
          name: 'CodePulse_0.1.6_x64-setup.exe',
          browser_download_url: installerUrl,
          digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
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
    installerUrl,
    installerSha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
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
            browser_download_url:
              'https://github.com/noeigenstate/CodePulse/releases/download/v0.1.5/CodePulse_0.1.5_x64-setup.exe',
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
      assets: [
        {
          name: 'latest.yml',
          browser_download_url:
            'https://github.com/noeigenstate/CodePulse/releases/download/v0.1.6/latest.yml',
        },
      ],
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
          browser_download_url:
            'https://github.com/noeigenstate/CodePulse/releases/download/v0.1.6/CodePulse_0.1.5_x64-setup.exe',
        },
      ],
    },
    '0.1.5',
  )

  assert.equal(info?.installable, false)
  assert.equal(info?.installerName, undefined)
  assert.equal(info?.installerUrl, undefined)
})

test('buildDownloadCandidates defaults to official URL only', () => {
  const url =
    'https://github.com/noeigenstate/CodePulse/releases/download/v0.1.9/CodePulse_0.1.9_x64-setup.exe'
  assert.deepEqual(buildDownloadCandidates(url, { allowMirrors: false }), [url])
  assert.deepEqual(buildDownloadCandidates(url, { allowMirrors: true })[0], url)
  assert.ok(
    buildDownloadCandidates(url, { allowMirrors: true }).some((u) => u.includes('gh-proxy.com')),
  )
  assert.throws(() => buildDownloadCandidates('https://example.test/app.exe'), /allowlist/i)
})

test('isAllowedUpdateUrl and parseSha256Digest', () => {
  assert.equal(isAllowedUpdateUrl('https://github.com/noeigenstate/CodePulse/releases/x'), true)
  assert.equal(isAllowedUpdateUrl('http://github.com/x'), false)
  assert.equal(isAllowedUpdateUrl('https://evil.example/x'), false)
  assert.equal(isAllowedUpdateUrl('https://gh-proxy.com/x', true), true)
  assert.equal(isAllowedUpdateUrl('https://gh-proxy.com/x', false), false)
  assert.equal(
    parseSha256Digest('sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  )
  assert.equal(
    parseSha256Digest('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  file.exe'),
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  )
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
