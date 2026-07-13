import { createWriteStream } from 'node:fs'
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { join } from 'node:path'
import { URL } from 'node:url'
import type { UpdateInfo } from '@codepulse/shared'

const LATEST_RELEASE_URL = 'https://api.github.com/repos/noeigenstate/CodePulse/releases/latest'
const USER_AGENT = 'CodePulse-Desktop'
const MAX_REDIRECTS = 8
/** Idle socket timeout while waiting for headers / next chunk (slow links need headroom). */
const REQUEST_IDLE_TIMEOUT_MS = 120_000
/** Absolute ceiling for a full installer download (~70MB over slow links). */
const DOWNLOAD_HARD_TIMEOUT_MS = 20 * 60_000
/** Use multi-connection downloads above this size. */
const PARALLEL_MIN_BYTES = 4 * 1024 * 1024
const PARALLEL_CONNECTIONS = 6
/** How long to wait when racing mirrors for the first usable probe. */
const MIRROR_RACE_MS = 6_000

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

interface ProbeResult {
  url: string
  total?: number
  acceptRanges: boolean
}

const httpAgent = new HttpAgent({
  keepAlive: true,
  maxSockets: PARALLEL_CONNECTIONS + 2,
  keepAliveMsecs: 15_000,
})
const httpsAgent = new HttpsAgent({
  keepAlive: true,
  maxSockets: PARALLEL_CONNECTIONS + 2,
  keepAliveMsecs: 15_000,
})

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

/**
 * Candidate download URLs.
 *
 * Acceleration mirrors are listed **before** official GitHub: direct
 * github.com / objects.githubusercontent.com downloads often stall or time out
 * in regions with poor GitHub connectivity. Official URL stays as the last fallback.
 */
export function buildDownloadCandidates(installerUrl: string): string[] {
  const original = installerUrl.trim()
  if (!original) return []
  if (!/^https:\/\/(github\.com|objects\.githubusercontent\.com)\//i.test(original)) {
    return [original]
  }
  return [
    `https://ghfast.top/${original}`,
    `https://gh-proxy.com/${original}`,
    `https://ghproxy.net/${original}`,
    original,
  ]
}

/** Split a file into contiguous byte ranges for parallel download. */
export function planByteRanges(
  total: number,
  connections = PARALLEL_CONNECTIONS,
): Array<{ start: number; end: number }> {
  if (total <= 0) return []
  // Aim for the requested connection count, but avoid tiny ranges under 256KB.
  const parts = Math.max(1, Math.min(connections, Math.ceil(total / (256 * 1024))))
  const chunk = Math.ceil(total / parts)
  const ranges: Array<{ start: number; end: number }> = []
  for (let i = 0; i < parts; i++) {
    const start = i * chunk
    if (start >= total) break
    const end = Math.min(total - 1, start + chunk - 1)
    ranges.push({ start, end })
  }
  return ranges
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
  const candidates = buildDownloadCandidates(update.installerUrl)

  // Quick size probe (best-effort) so we can reuse a complete local cache.
  const quickProbe = await pickDownloadSource(candidates).catch(() => undefined)
  if (await isCompleteCachedFile(destination, quickProbe?.total)) {
    onProgress?.({
      received: quickProbe?.total ?? 0,
      total: quickProbe?.total,
      percent: 100,
    })
    return destination
  }

  // Prefer the fastest probe first, then walk remaining candidates if download fails.
  // Critical: a source that answers HEAD quickly can still time out on the full body.
  const ordered = await orderCandidatesForDownload(candidates)
  const errors: string[] = []

  for (const url of ordered) {
    try {
      await unlink(destination).catch(() => undefined)
      const probe = await probeUrl(url)
      await downloadWithHardTimeout(probe, destination, onProgress)
      await verifyDownloadedFile(destination, probe.total)
      return destination
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${url}: ${message}`)
      console.error('[codepulse] installer download failed, trying next source', url, message)
      await unlink(destination).catch(() => undefined)
      // Clear partial part files from parallel attempts.
      await cleanupPartFiles(destination)
    }
  }

  throw new Error(
    `All download sources failed. Last errors:\n${errors.slice(-4).join('\n')}\nYou can also open the release page and install manually.`,
  )
}

/**
 * Race mirrors for the first healthy probe, then append the remaining candidates
 * so a successful probe that later fails mid-download is not the only attempt.
 */
export async function pickDownloadSource(candidates: string[]): Promise<ProbeResult> {
  if (candidates.length === 0) throw new Error('No download candidates.')
  if (candidates.length === 1) return probeUrl(candidates[0]!)

  const controllers = candidates.map(() => new AbortController())
  const race = Promise.any(
    candidates.map(async (url, index) => {
      const result = await probeUrl(url, controllers[index]!.signal)
      for (const controller of controllers) controller.abort()
      return result
    }),
  )

  try {
    return await Promise.race([
      race,
      sleep(MIRROR_RACE_MS).then(() => {
        throw new Error('mirror-race-timeout')
      }),
    ])
  } catch {
    for (const controller of controllers) controller.abort()
    let lastError: unknown
    for (const url of candidates) {
      try {
        return await probeUrl(url)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to probe installer download sources: ${String(lastError)}`)
  }
}

/** Fastest successful probe first; keep remaining candidates as ordered fallbacks. */
async function orderCandidatesForDownload(candidates: string[]): Promise<string[]> {
  if (candidates.length <= 1) return candidates
  try {
    const winner = await pickDownloadSource(candidates)
    return [winner.url, ...candidates.filter((url) => url !== winner.url)]
  } catch {
    return candidates
  }
}

async function cleanupPartFiles(destination: string): Promise<void> {
  await Promise.all(
    Array.from({ length: PARALLEL_CONNECTIONS }, (_, index) =>
      unlink(`${destination}.part${index}`).catch(() => undefined),
    ),
  )
  await unlink(`${destination}.download`).catch(() => undefined)
}

async function downloadWithHardTimeout(
  probe: ProbeResult,
  destination: string,
  onProgress?: DownloadProgressListener,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      downloadFromProbe(probe, destination, onProgress),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(`Download timed out after ${DOWNLOAD_HARD_TIMEOUT_MS / 1000}s: ${probe.url}`),
          )
        }, DOWNLOAD_HARD_TIMEOUT_MS)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function downloadFromProbe(
  probe: ProbeResult,
  destination: string,
  onProgress?: DownloadProgressListener,
): Promise<void> {
  const total = probe.total
  if (probe.acceptRanges && typeof total === 'number' && total >= PARALLEL_MIN_BYTES) {
    await downloadParallel(probe.url, destination, total, onProgress)
    return
  }
  await downloadSingle(probe.url, destination, onProgress, total)
}

async function probeUrl(url: string, signal?: AbortSignal): Promise<ProbeResult> {
  try {
    const head = await openResponse(url, { ...downloadHeaders() }, MAX_REDIRECTS, 'HEAD', signal)
    head.resume()
    await onceEnd(head)
    if ((head.statusCode ?? 0) >= 200 && (head.statusCode ?? 0) < 300) {
      return {
        url,
        total: parseContentLength(head.headers['content-length']),
        acceptRanges: supportsRanges(head.headers['accept-ranges'], head.headers['content-length']),
      }
    }
  } catch {
    // fall through
  }

  const response = await openResponse(
    url,
    { ...downloadHeaders(), Range: 'bytes=0-0' },
    MAX_REDIRECTS,
    'GET',
    signal,
  )
  response.resume()
  await onceEnd(response)

  if (response.statusCode !== 200 && response.statusCode !== 206) {
    throw new Error(`Probe failed with HTTP ${response.statusCode}: ${url}`)
  }

  const total =
    parseContentRangeTotal(response.headers['content-range']) ??
    parseContentLength(response.headers['content-length'])

  return {
    url,
    total,
    acceptRanges:
      response.statusCode === 206 ||
      supportsRanges(response.headers['accept-ranges'], response.headers['content-length']),
  }
}

async function downloadParallel(
  url: string,
  destination: string,
  total: number,
  onProgress?: DownloadProgressListener,
): Promise<void> {
  const ranges = planByteRanges(total, PARALLEL_CONNECTIONS)
  const partPaths = ranges.map((_, index) => `${destination}.part${index}`)
  const receivedByPart = ranges.map(() => 0)

  const report = (): void => {
    if (!onProgress) return
    const received = receivedByPart.reduce((sum, value) => sum + value, 0)
    onProgress({
      received,
      total,
      percent: Math.min(100, Math.round((received / total) * 100)),
    })
  }

  try {
    await Promise.all(
      ranges.map(async (range, index) => {
        await downloadRangeToFile(url, partPaths[index]!, range.start, range.end, (delta) => {
          receivedByPart[index] = delta
          report()
        })
      }),
    )

    const handle = await open(destination, 'w')
    try {
      for (const partPath of partPaths) {
        const part = await open(partPath, 'r')
        try {
          const buffer = Buffer.alloc(64 * 1024)
          while (true) {
            const { bytesRead } = await part.read(buffer, 0, buffer.length, null)
            if (bytesRead <= 0) break
            await handle.write(buffer, 0, bytesRead)
          }
        } finally {
          await part.close()
        }
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    await unlink(destination).catch(() => undefined)
    throw error
  } finally {
    await Promise.all(partPaths.map((partPath) => unlink(partPath).catch(() => undefined)))
  }

  report()
}

async function downloadRangeToFile(
  url: string,
  path: string,
  start: number,
  end: number,
  onBytes: (receivedInPart: number) => void,
): Promise<void> {
  const expected = end - start + 1
  const response = await openResponse(
    url,
    { ...downloadHeaders(), Range: `bytes=${start}-${end}` },
    MAX_REDIRECTS,
    'GET',
  )

  if (response.statusCode !== 206 && response.statusCode !== 200) {
    response.resume()
    throw new Error(`Range download failed with HTTP ${response.statusCode}: ${url}`)
  }

  await writeResponseToFile(response, path, (received) => onBytes(received))

  const info = await stat(path)
  if (response.statusCode === 206 && info.size !== expected) {
    await unlink(path).catch(() => undefined)
    throw new Error(`Range size mismatch for ${url} (${info.size} != ${expected})`)
  }
}

async function downloadSingle(
  url: string,
  destination: string,
  onProgress?: DownloadProgressListener,
  knownTotal?: number,
): Promise<void> {
  const tempPath = `${destination}.download`
  await unlink(tempPath).catch(() => undefined)

  const response = await openResponse(url, downloadHeaders(), MAX_REDIRECTS, 'GET')
  if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
    response.resume()
    throw new Error(`Download failed with HTTP ${response.statusCode}: ${url}`)
  }

  const total = knownTotal ?? parseContentLength(response.headers['content-length'])
  await writeResponseToFile(response, tempPath, (received) => {
    if (!onProgress) return
    const percent =
      total && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : undefined
    onProgress({ received, total, percent })
  })
  await rename(tempPath, destination)
}

function writeResponseToFile(
  response: IncomingMessage,
  path: string,
  onBytes: (received: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(path)
    let received = 0
    let settled = false

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      response.destroy()
      file.destroy()
      void unlink(path).catch(() => undefined)
      reject(error)
    }

    response.on('data', (chunk: Buffer) => {
      received += chunk.length
      onBytes(received)
    })
    response.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
    response.on('aborted', () => fail(new Error('Download aborted')))

    file.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
    file.on('finish', () => {
      if (settled) return
      settled = true
      resolve()
    })

    response.pipe(file)
  })
}

function openResponse(
  url: string,
  headers: Record<string, string>,
  redirects: number,
  method: 'GET' | 'HEAD',
  signal?: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'))
      return
    }

    const parsed = new URL(url)
    const isHttps = parsed.protocol === 'https:'
    const request = isHttps ? httpsRequest : httpRequest
    const agent = isHttps ? httpsAgent : httpAgent

    const req = request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
        agent,
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
          openResponse(redirected, headers, redirects - 1, method, signal).then(resolve, reject)
          return
        }

        resolve(response)
      },
    )

    const onAbort = (): void => {
      req.destroy(new Error('Aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    req.setTimeout(REQUEST_IDLE_TIMEOUT_MS, () => {
      req.destroy(
        new Error(`Request timed out after ${REQUEST_IDLE_TIMEOUT_MS / 1000}s idle: ${url}`),
      )
    })
    req.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    req.end()
  })
}

function onceEnd(stream: IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on('end', () => resolve())
    stream.on('error', reject)
    // HEAD responses may end immediately with no body.
    if (stream.complete) resolve()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

async function isCompleteCachedFile(
  path: string,
  expectedSize: number | undefined,
): Promise<boolean> {
  try {
    const info = await stat(path)
    if (info.size < 1_000_000) return false
    if (expectedSize != null && expectedSize > 0) return info.size === expectedSize
    return info.size > 1_000_000
  } catch {
    return false
  }
}

async function verifyDownloadedFile(path: string, expectedSize: number | undefined): Promise<void> {
  const info = await stat(path)
  if (info.size <= 0) {
    throw new Error('Downloaded installer is empty.')
  }
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
  const response = await openResponse(
    url,
    {
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    5,
    'GET',
  )
  const text = await readResponseText(response)
  if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
    throw new Error(`Request failed with HTTP ${response.statusCode}: ${url}`)
  }
  return JSON.parse(text) as unknown
}

function readResponseText(response: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    response.on('data', (chunk: Buffer) => chunks.push(chunk))
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    response.on('error', reject)
  })
}

function downloadHeaders(): Record<string, string> {
  return {
    Accept: 'application/octet-stream,*/*;q=0.8',
    'User-Agent': USER_AGENT,
  }
}

function parseContentLength(value: string | string[] | undefined): number | undefined {
  if (value == null) return undefined
  const raw = Array.isArray(value) ? value[0] : value
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function parseContentRangeTotal(value: string | string[] | undefined): number | undefined {
  if (value == null) return undefined
  const raw = Array.isArray(value) ? value[0] : value
  const match = String(raw).match(/\/(\d+)\s*$/)
  if (!match) return undefined
  const n = Number(match[1])
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function supportsRanges(
  acceptRanges: string | string[] | undefined,
  contentLength: string | string[] | undefined,
): boolean {
  const value = Array.isArray(acceptRanges) ? acceptRanges.join(',') : acceptRanges
  if (value && /bytes/i.test(value)) return true
  // GitHub CDN often omits Accept-Ranges on HEAD but still honors Range.
  return parseContentLength(contentLength) != null
}
