import { createWriteStream } from 'node:fs'
import { mkdir, stat, unlink } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { join } from 'node:path'
import { URL } from 'node:url'
import type { IncomingMessage } from 'node:http'
import type { UpdateInfo } from '@codepulse/shared'

const LATEST_RELEASE_URL = 'https://api.github.com/repos/noeigenstate/CodePulse/releases/latest'
const MAX_REDIRECTS = 8
/** Idle socket timeout while waiting for headers / next chunk. */
const REQUEST_IDLE_TIMEOUT_MS = 30_000
/** Absolute ceiling for a full installer download (~70MB over slow links). */
const DOWNLOAD_HARD_TIMEOUT_MS = 15 * 60_000
const USER_AGENT = 'CodePulse-Desktop'

export interface DownloadProgress {
  received: number
  total?: number
  percent?: number
}

export type DownloadProgressListener = (progress: DownloadProgress) => void

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

  return {
    currentVersion,
    version,
    tag,
    releaseUrl:
      pickString(payload.html_url) ??
      `https://github.com/noeigenstate/CodePulse/releases/tag/${encodeURIComponent(tag)}`,
    installable: Boolean(installer),
    installerName: installer?.name,
    installerUrl: installer?.url,
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

export async function downloadInstaller(
  update: UpdateInfo,
  directory: string,
  onProgress?: DownloadProgressListener,
): Promise<string> {
  if (!update.installable || !update.installerName || !update.installerUrl) {
    throw new Error('No matching Windows installer is available for this release.')
  }

  await mkdir(directory, { recursive: true })
  const destination = join(directory, sanitizeInstallerName(update.installerName))
  // Always re-download so a partial/corrupt previous attempt cannot hang install.
  await unlink(destination).catch(() => undefined)
  await downloadFile(update.installerUrl, destination, onProgress)
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
  const text = await requestText(url, {
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  })
  return JSON.parse(text) as unknown
}

function requestText(
  url: string,
  headers: Record<string, string>,
  redirects = MAX_REDIRECTS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    openResponse(url, headers, redirects)
      .then((response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        response.on('error', reject)
      })
      .catch(reject)
  })
}

function downloadFile(
  url: string,
  destination: string,
  onProgress?: DownloadProgressListener,
  redirects = MAX_REDIRECTS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let received = 0
    let hardTimer: NodeJS.Timeout | undefined
    let file: ReturnType<typeof createWriteStream> | undefined

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      if (hardTimer) clearTimeout(hardTimer)
      file?.destroy()
      void unlink(destination).catch(() => undefined)
      reject(error)
    }

    const succeed = () => {
      if (settled) return
      settled = true
      if (hardTimer) clearTimeout(hardTimer)
      resolve()
    }

    hardTimer = setTimeout(() => {
      fail(new Error(`Download timed out after ${DOWNLOAD_HARD_TIMEOUT_MS / 1000}s: ${url}`))
    }, DOWNLOAD_HARD_TIMEOUT_MS)
    hardTimer.unref?.()

    openResponse(url, downloadHeaders(), redirects)
      .then((response) => {
        const total = contentLength(response)
        file = createWriteStream(destination)

        file.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
        file.on('finish', () => {
          file?.close((closeError) => {
            if (closeError) {
              fail(closeError)
              return
            }
            void verifyDownloadedFile(destination, total).then(succeed, fail)
          })
        })

        response.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
        response.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (!onProgress) return
          const percent =
            total && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : undefined
          onProgress({ received, total, percent })
        })
        response.on('aborted', () => fail(new Error(`Download aborted: ${url}`)))

        response.pipe(file)
      })
      .catch((error: unknown) => {
        fail(error instanceof Error ? error : new Error(String(error)))
      })
  })
}

async function verifyDownloadedFile(path: string, expectedSize: number | undefined): Promise<void> {
  const info = await stat(path)
  if (info.size <= 0) {
    throw new Error('Downloaded installer is empty.')
  }
  // Installers are tens of MB; a few KB body is almost always an HTML/JSON error page.
  if (info.size < 1_000_000) {
    throw new Error(
      `Downloaded installer is unexpectedly small (${info.size} bytes). The download may have failed.`,
    )
  }
  if (expectedSize != null && expectedSize > 0 && info.size !== expectedSize) {
    throw new Error(
      `Downloaded installer size mismatch (got ${info.size}, expected ${expectedSize}).`,
    )
  }
}

function contentLength(response: IncomingMessage): number | undefined {
  const raw = response.headers['content-length']
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function downloadHeaders(): Record<string, string> {
  return {
    // Avoid GitHub API JSON Accept when fetching release binaries / CDN redirects.
    Accept: 'application/octet-stream,*/*;q=0.8',
    'User-Agent': USER_AGENT,
  }
}

function openResponse(
  url: string,
  headers: Record<string, string>,
  redirects: number,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const get = parsed.protocol === 'http:' ? httpGet : httpsGet

    const req = get(
      parsed,
      {
        headers,
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
          openResponse(redirected, headers, redirects - 1).then(resolve, reject)
          return
        }

        if (statusCode < 200 || statusCode >= 300) {
          response.resume()
          reject(new Error(`Request failed with HTTP ${statusCode}: ${url}`))
          return
        }

        resolve(response)
      },
    )

    req.setTimeout(REQUEST_IDLE_TIMEOUT_MS, () => {
      req.destroy(
        new Error(`Request timed out after ${REQUEST_IDLE_TIMEOUT_MS / 1000}s idle: ${url}`),
      )
    })
    req.on('error', reject)
  })
}
