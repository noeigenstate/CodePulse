/**
 * Shared helpers for the CodePulse hook scripts.
 *
 * Dependency-free and defensive: a hook must NEVER block or crash the host
 * agent, so everything here swallows errors and bounds its own runtime.
 *
 * @module hooks/lib/post
 */

/** Default base URL of the local CodePulse server. */
const DEFAULT_URL = 'http://127.0.0.1:17888'

/**
 * Reads all of stdin and parses it as JSON.
 *
 * @returns {Promise<object>} The parsed object, `{}` if stdin was empty, or
 *   `{ _rawText }` if the input was not valid JSON. Never throws.
 */
export async function readStdinJson() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { _rawText: text }
  }
}

/**
 * Resolves the base URL of the local CodePulse server.
 *
 * @returns {string} The value of the `CODEPULSE_URL` env var, or the default
 *   loopback URL.
 */
export function serverUrl() {
  return process.env.CODEPULSE_URL || DEFAULT_URL
}

/**
 * Fire-and-forget POST to `/api/events` with a hard timeout.
 *
 * Callers ignore the result and exit 0 regardless, so a stopped or unreachable
 * server never affects the host agent.
 *
 * @param {unknown} payload The JSON body to send.
 * @param {{ timeoutMs?: number }} [options] Abort timeout in ms (default 1500).
 * @returns {Promise<boolean>} `true` on a 2xx response, `false` on any failure.
 */
export async function postEvent(payload, { timeoutMs = 1500 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${serverUrl()}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
