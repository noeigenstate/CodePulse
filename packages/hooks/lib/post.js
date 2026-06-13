/**
 * CodePulse hook 脚本的共享辅助函数。
 *
 * 零依赖且防御式：hook 绝不能阻塞或搞崩宿主 agent，
 * 因此这里的所有函数都吞掉错误并限定自身运行时长。
 *
 * @module hooks/lib/post
 */

/** 本地 CodePulse 服务器的默认基础 URL。 */
const DEFAULT_URL = 'http://127.0.0.1:17888'

/**
 * 读取全部 stdin 并解析为 JSON。
 *
 * @returns {Promise<object>} 解析后的对象；stdin 为空时为 `{}`；
 *   输入不是合法 JSON 时为 `{ _rawText }`。从不抛出。
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
 * 解析本地 CodePulse 服务器的基础 URL。
 *
 * @returns {string} `CODEPULSE_URL` 环境变量的值，或默认回环 URL。
 */
export function serverUrl() {
  return process.env.CODEPULSE_URL || DEFAULT_URL
}

/**
 * 向 `/api/events` 发起带硬超时的「发后即忘」POST。
 *
 * 调用方忽略结果并无条件以 0 退出，因此服务器停止或不可达
 * 绝不影响宿主 agent。
 *
 * @param {unknown} payload 要发送的 JSON 体。
 * @param {{ timeoutMs?: number }} [options] 中止超时（毫秒，默认 1500）。
 * @returns {Promise<boolean>} 2xx 响应为 `true`，任何失败为 `false`。
 */
export async function postEvent(
  payload,
  { timeoutMs = 1500, retries = 1, retryDelayMs = 200 } = {},
) {
  const attempts = Math.max(1, retries + 1)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await postEventOnce(payload, timeoutMs)) return true
    if (attempt < attempts - 1 && retryDelayMs > 0) await delay(retryDelayMs)
  }
  return false
}

async function postEventOnce(payload, timeoutMs) {
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
