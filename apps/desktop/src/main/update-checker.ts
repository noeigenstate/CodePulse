import { createWriteStream } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { join } from 'node:path'
import { URL } from 'node:url'
import type { IncomingMessage } from 'node:http'
import type { UpdateInfo } from '@codepulse/shared'

const LATEST_RELEASE_URL = 'https://api.github.com/repos/noeigenstate/CodePulse/releases/latest'
const MAX_REDIRECTS = 5
const REQUEST_TIMEOUT_MS = 15_000

interface ReleaseAsset {
  name?: unknown
  browser_download_url?: unknown
}

interface ReleasePayload {
  tag_name?: unknown
  html_url?: unknown
  assets?: unknown
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo | null> {
  const release = await requestJson(LATEST_RELEASE_URL)
  return buildUpdateInfo(release, currentVersion)
}

export function buildUpdateInfo(release: unknown, currentVersion: string): UpdateInfo | null {
  const payload = asReleasePayload(release)
  if (!payload) return null

  const tag = pickString(payload.tag_name)
  const version = tag ? parseVersionString(tag) : undefined
  if (!tag || !version || !isNewerVersion(version, currentVersion)) return null

  const installer = findWindowsInstaller(payload.assets, version)
  if (!installer) return null

  return {
    currentVersion,
    version,
    tag,
    releaseUrl:
      pickString(payload.html_url) ??
      `https://github.com/noeigenstate/CodePulse/releases/tag/${encodeURIComponent(tag)}`,
    installerName: installer.name,
    installerUrl: installer.url,
  }
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parsedA = parseVersionParts(a)
  const parsedB = parseVersionParts(b)
  if (!parsedA || !parsedB) return 0

  const length = Math.max(parsedA.length, parsedB.length)
  for (let i = 0; i < length; i++) {
    const left = parsedA[i] ?? 0
    const right = parsedB[i] ?? 0
    if (left > right) return 1
    if (left < right) return -1
  }
  return 0
}

export function isNewerVersion(latestVersion: string, currentVersion: string): boolean {
  if (!parseVersionParts(latestVersion) || !parseVersionParts(currentVersion)) return false
  return compareVersions(latestVersion, currentVersion) > 0
}

export async function downloadInstaller(update: UpdateInfo, directory: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  const destination = join(directory, sanitizeInstallerName(update.installerName))
  await downloadFile(update.installerUrl, destination)
  return destination
}

function asReleasePayload(value: unknown): ReleasePayload | null {
  if (!value || typeof value !== 'object') return null
  return value as ReleasePayload
}

function findWindowsInstaller(
  assets: unknown,
  version: string,
): { name: string; url: string } | null {
  if (!Array.isArray(assets)) return null
  for (const rawAsset of assets) {
    const asset = rawAsset as ReleaseAsset
    const name = pickString(asset.name)
    const url = pickString(asset.browser_download_url)
    if (!name || !url) continue
    const lower = name.toLowerCase()
    if (lower.endsWith('.exe') && lower.includes(version.toLowerCase())) return { name, url }
  }
  return null
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parseVersionString(version: string): string | undefined {
  const parts = parseVersionParts(version)
  return parts ? parts.join('.') : undefined
}

function parseVersionParts(version: string): number[] | null {
  const match = version.trim().match(/^v?(\d+(?:\.\d+){1,3})(?:[-+].*)?$/i)
  if (!match) return null
  return match[1]!.split('.').map((part) => Number(part))
}

function sanitizeInstallerName(name: string): string {
  const safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  return safe.toLowerCase().endsWith('.exe') ? safe : `${safe}.exe`
}

async function requestJson(url: string): Promise<unknown> {
  const text = await requestText(url)
  return JSON.parse(text) as unknown
}

function requestText(url: string, redirects = MAX_REDIRECTS): Promise<string> {
  return new Promise((resolve, reject) => {
    request(url, redirects, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    }).catch(reject)
  })
}

function downloadFile(url: string, destination: string, redirects = MAX_REDIRECTS): Promise<void> {
  return new Promise((resolve, reject) => {
    request(url, redirects, (response) => {
      const file = createWriteStream(destination)
      file.on('finish', () => {
        file.close(() => resolve())
      })
      file.on('error', (err) => {
        void unlink(destination).catch(() => undefined)
        reject(err)
      })
      response.pipe(file)
    }).catch(reject)
  })
}

async function request(
  url: string,
  redirects: number,
  onSuccess: (response: IncomingMessage) => void,
): Promise<void> {
  const parsed = new URL(url)
  const get = parsed.protocol === 'http:' ? httpGet : httpsGet

  await new Promise<void>((resolve, reject) => {
    const req = get(
      parsed,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'CodePulse',
        },
      },
      (response) => {
        const statusCode = response.statusCode ?? 0
        const location = response.headers.location

        if (statusCode >= 300 && statusCode < 400 && location) {
          response.resume()
          if (redirects <= 0) {
            reject(new Error(`Too many redirects while requesting ${url}`))
            return
          }
          const redirected = new URL(location, parsed).toString()
          request(redirected, redirects - 1, onSuccess).then(resolve, reject)
          return
        }

        if (statusCode < 200 || statusCode >= 300) {
          response.resume()
          reject(new Error(`Request failed with HTTP ${statusCode}: ${url}`))
          return
        }

        onSuccess(response)
        response.on('end', resolve)
      },
    )

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timed out: ${url}`))
    })
    req.on('error', reject)
  })
}
