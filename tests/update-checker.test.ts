import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildUpdateInfo,
  compareVersions,
  isNewerVersion,
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
  const info = buildUpdateInfo(
    {
      tag_name: 'v0.1.6',
      html_url: 'https://github.com/noeigenstate/CodePulse/releases/tag/v0.1.6',
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
    installerName: 'CodePulse_0.1.6_x64-setup.exe',
    installerUrl: 'https://example.test/installer',
  })
})

test('buildUpdateInfo returns null when release has no newer Windows installer', () => {
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

  assert.equal(
    buildUpdateInfo(
      {
        tag_name: 'v0.1.6',
        html_url: 'https://github.com/noeigenstate/CodePulse/releases/tag/v0.1.6',
        assets: [{ name: 'latest.yml', browser_download_url: 'https://example.test/latest.yml' }],
      },
      '0.1.5',
    ),
    null,
  )
})

test('buildUpdateInfo ignores installer assets that do not match the release version', () => {
  assert.equal(
    buildUpdateInfo(
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
    ),
    null,
  )
})
