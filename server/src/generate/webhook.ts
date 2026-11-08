import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { createHmac } from 'node:crypto'
import type { PluginCard, PluginManifest, PluginSettingValues } from '@codepulse/shared'
import { HttpError, validateCards } from '../validation.js'

const MAX_BYTES = 64 * 1024
export type ResolveHost = (hostname: string) => Promise<string[]>
export interface WebhookRequest {
  url: URL
  address: string
  body: string
  headers: Record<string, string>
  signal: AbortSignal
}
export interface WebhookResponse {
  status: number
  body: string
}
export type WebhookTransport = (request: WebhookRequest) => Promise<WebhookResponse>

export const resolveHost: ResolveHost = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)

function ipv4Public(address: string): boolean {
  const [a, b, c] = address.split('.').map(Number)
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  )
}

function ipv6Words(address: string): number[] {
  let input = address.toLowerCase()
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':')
    const bytes = input
      .slice(lastColon + 1)
      .split('.')
      .map(Number)
    input = `${input.slice(0, lastColon)}:${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`
  }
  const [left, right] = input.split('::')
  const a = left ? left.split(':').map((word) => parseInt(word, 16)) : []
  const b = right ? right.split(':').map((word) => parseInt(word, 16)) : []
  return right === undefined ? a : [...a, ...Array<number>(8 - a.length - b.length).fill(0), ...b]
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return ipv4Public(address)
  if (isIP(address) !== 6 || address.includes('%')) return false
  const w = ipv6Words(address)
  if (w.slice(0, 5).every((n) => n === 0) && w[5] === 0xffff) {
    return ipv4Public(`${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`)
  }
  // Only global unicast is eligible; reject transition and special-purpose allocations too.
  return (
    w[0] >= 0x2000 &&
    w[0] <= 0x3fff &&
    !(w[0] === 0x2001 && (w[1] < 0x200 || w[1] === 0xdb8)) &&
    w[0] !== 0x2002 &&
    !(w[0] === 0x3fff && w[1] < 0x1000)
  )
}

export async function deadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  ms = 5000,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('生成超时，请稍后再试'))
      controller.abort()
    }, ms)
  })
  try {
    return await Promise.race([operation(controller.signal), expired])
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

export async function checkedEndpoint(
  endpoint: string,
  resolve: ResolveHost,
  allowHttpLoopback: boolean,
): Promise<{ url: URL; address: string }> {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new HttpError(422, '接口地址无效')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const localHttp =
    allowHttpLoopback &&
    url.protocol === 'http:' &&
    (hostname === '127.0.0.1' || hostname === 'localhost')
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.hash)
    throw new HttpError(422, '接口必须使用HTTPS且不能包含账号或片段')
  const addresses = isIP(hostname) ? [hostname] : await resolve(hostname)
  const permitted = (address: string) =>
    localHttp ? address === '127.0.0.1' || address === '::1' : isPublicAddress(address)
  if (!addresses.length || !addresses.every(permitted))
    throw new HttpError(422, '接口地址不允许访问内网或保留地址')
  return { url, address: addresses[0] }
}

export const nodeTransport: WebhookTransport = ({ url, address, body, headers, signal }) =>
  new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = request(
      url,
      {
        method: 'POST',
        agent: false,
        headers,
        signal,
        // A fresh connection pins this lookup result; the URL retains Host, TLS verification and SNI.
        family: isIP(address),
        lookup: (_hostname, _options, callback) => callback(null, address, isIP(address)),
      },
      (response) => {
        if (Number(response.headers['content-length']) > MAX_BYTES) {
          response.destroy()
          reject(new Error('接口响应超过64 KiB'))
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BYTES) {
            response.destroy(new Error('接口响应超过64 KiB'))
            return
          }
          chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(body)
  })

export async function webhookCards(options: {
  manifest: PluginManifest
  endpoint: string
  secret: string
  settings: PluginSettingValues
  now: number
  resolve: ResolveHost
  allowHttpLoopback: boolean
  transport: WebhookTransport
  signal: AbortSignal
}): Promise<PluginCard[]> {
  const { manifest, settings, now, signal } = options
  const target = await checkedEndpoint(options.endpoint, options.resolve, options.allowHttpLoopback)
  if (signal.aborted) throw new Error('生成超时，请稍后再试')
  const body = JSON.stringify({
    v: 1,
    pluginId: manifest.id,
    version: manifest.version,
    settings,
    locale: 'zh-CN',
    now,
  })
  const timestamp = String(now)
  const signature = createHmac('sha256', options.secret)
    .update(`${timestamp}.${body}`)
    .digest('hex')
  const response = await options.transport({
    ...target,
    body,
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
      'X-CodePulse-Timestamp': timestamp,
      'X-CodePulse-Signature': `sha256=${signature}`,
    },
  })
  if (response.status >= 300 && response.status < 400) throw new Error('接口不允许重定向')
  if (response.status < 200 || response.status >= 300) throw new Error('接口返回失败状态')
  if (Buffer.byteLength(response.body) > MAX_BYTES) throw new Error('接口响应超过64 KiB')
  let data: unknown
  try {
    data = JSON.parse(response.body)
  } catch {
    throw new Error('接口返回的JSON无效')
  }
  const cards = data && typeof data === 'object' ? (data as { cards?: unknown }).cards : undefined
  return validateCards(cards, now, now + 2 * manifest.refreshMinutes * 60000, 12, 0)
}
