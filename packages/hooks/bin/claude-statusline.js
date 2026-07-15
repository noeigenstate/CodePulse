#!/usr/bin/env node
/**
 * 面向 Claude Code 的 CodePulse status-line 收集器。
 *
 * 配置为 Claude 的 `statusLine.command`。Claude 通过 stdin 管道传入
 * 会话 JSON（model、workspace、cost、transcript_path），并期望 stdout
 * 输出单行状态文本。
 *
 * Claude 的 status-line 载荷并不携带 token 数或上下文百分比，
 * 它们存在于会话 transcript（`transcript_path`）中，每条助手消息
 * 一个 `usage` 块。因此本脚本读取 transcript 尾部，找到最新的
 * `usage`，推导上下文规模与百分比，转发给 CodePulse，
 * 同时为 Claude 打印一行紧凑状态。
 *
 * 一切都是尽力而为、有时间上限（约 600 毫秒）且防御式的：
 * 从不抛出且总会输出一行，因此不会拖慢或破坏提示符。
 *
 * @module hooks/bin/claude-statusline
 */
import { statSync, openSync, readSync, closeSync } from 'node:fs'
import { readStdinJson, postEvent } from '../lib/post.js'
import { resolveClaudeRateLimitsForStatusline } from '../lib/claude-quota.js'

/** 默认模型上下文窗口，可通过 CODEPULSE_CONTEXT_WINDOW 覆盖。 */
const CONTEXT_WINDOW = parseTokenCount(process.env.CODEPULSE_CONTEXT_WINDOW) ?? 200000
/** 从 transcript 末尾扫描 usage 块的字节数。 */
const TAIL_BYTES = 512 * 1024

const data = await readStdinJson()

const officialContextWindow = normalizeContextWindow(data?.context_window)
const usage = officialContextWindow ? null : readLatestUsage(data?.transcript_path)
let tokenPatch = {}
if (officialContextWindow) {
  tokenPatch = officialContextWindow
} else if (usage) {
  // 当前上下文规模是最新一轮的整个输入侧：
  // 新输入 + 缓存读取 + 缓存写入。输出是模型的回复。
  const input =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  const output = usage.output_tokens ?? 0
  tokenPatch = {
    usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
    context_used_percent: Math.min(100, Math.round((input / CONTEXT_WINDOW) * 100)),
  }
}

// 额度：stdin rate_limits → OAuth usage → 本地缓存（主动补齐「等待命令行同步额度」）。
const quota = await resolveClaudeRateLimitsForStatusline(data ?? {}, { timeoutMs: 900 })

// 尽力转发：合并上下文补丁 + 解析后的额度。
// 超时略放宽，避免本机认证 + 额度拉取后 600ms 内丢快照。
await postEvent(
  {
    source: 'claude_code',
    channel: 'statusline',
    ...data,
    ...tokenPatch,
    ...(quota?.rate_limits != null ? { rate_limits: quota.rate_limits } : {}),
    ...(quota?.rate_limit_id != null ? { rate_limit_id: quota.rate_limit_id } : {}),
    ...(quota?.rate_limit_name != null ? { rate_limit_name: quota.rate_limit_name } : {}),
    ...(data?.rate_limits_available != null
      ? { rate_limits_available: data.rate_limits_available }
      : {}),
  },
  { timeoutMs: 2_000 },
)

const model = data?.model?.display_name ?? data?.model?.id ?? 'Claude'
const dir = data?.workspace?.current_dir ?? data?.cwd ?? ''
const dirName = dir
  ? dir
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop()
  : ''
const ctx =
  tokenPatch.context_used_percent ??
  data?.context_window?.used_percentage ??
  data?.context_used_percent
const ctxText = typeof ctx === 'number' ? ` · ctx ${Math.round(ctx)}%` : ''

process.stdout.write(`⏺ ${model}${dirName ? ` · ${dirName}` : ''}${ctxText}`)
process.exit(0)

/**
 * 读取 Claude transcript（JSONL）的尾部，返回最近一条助手消息的
 * `usage` 对象。
 *
 * 只读取最后 {@link TAIL_BYTES} 字节（最新一轮总在文件末尾附近），
 * 从末尾向前逐行解析直到找到 usage 块。切片的首行可能被截断 ——
 * 它只是解析失败被跳过。从不抛出。
 *
 * @param {unknown} transcriptPath `.jsonl` transcript 的路径（如有）。
 * @returns {Record<string, number> | null} 最新的 usage 块，或 `null`。
 */
function readLatestUsage(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null
  try {
    const size = statSync(transcriptPath).size
    const readBytes = Math.min(size, TAIL_BYTES)
    const fd = openSync(transcriptPath, 'r')
    try {
      const buf = Buffer.alloc(readBytes)
      readSync(fd, buf, 0, readBytes, size - readBytes)
      const lines = buf.toString('utf8').split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim()
        if (!line || line[0] !== '{') continue
        let obj
        try {
          obj = JSON.parse(line)
        } catch {
          continue
        }
        const u = obj?.message?.usage ?? obj?.usage
        if (u && typeof u.input_tokens === 'number') return u
      }
    } finally {
      closeSync(fd)
    }
  } catch {
    // transcript 不可读/缺失 —— 退回无 token 数据
  }
  return null
}

/**
 * Claude Code v2.1.132+ 会直接把准确的 context window 字段送到 status-line。
 * 优先使用这些字段；只有旧版本缺失时才回退到 transcript 估算。
 *
 * @param {unknown} value status-line stdin 中的 `context_window`。
 * @returns {Record<string, unknown> | null} 可合并进转发 payload 的 token 字段。
 */
function normalizeContextWindow(value) {
  if (!value || typeof value !== 'object') return null
  const used = value.used_percentage
  const input = value.total_input_tokens
  const output = value.total_output_tokens
  const current = value.current_usage
  const currentInput =
    current && typeof current === 'object'
      ? (numberValue(current.input_tokens) ?? 0) +
        (numberValue(current.cache_read_input_tokens) ?? 0) +
        (numberValue(current.cache_creation_input_tokens) ?? 0)
      : undefined
  const currentOutput =
    current && typeof current === 'object' ? numberValue(current.output_tokens) : undefined
  const contextWindowSize = numberValue(value.context_window_size)
  const effectiveInput = typeof input === 'number' ? input : currentInput
  const effectiveOutput = typeof output === 'number' ? output : currentOutput
  const effectiveUsed =
    typeof used === 'number'
      ? Math.round(used)
      : contextWindowSize && effectiveInput
        ? Math.min(100, Math.round((effectiveInput / contextWindowSize) * 100))
        : undefined
  if (
    typeof effectiveUsed !== 'number' &&
    typeof effectiveInput !== 'number' &&
    typeof effectiveOutput !== 'number'
  ) {
    return null
  }
  return {
    usage: {
      input_tokens: typeof effectiveInput === 'number' ? effectiveInput : undefined,
      output_tokens: typeof effectiveOutput === 'number' ? effectiveOutput : undefined,
      total_tokens:
        typeof effectiveInput === 'number' || typeof effectiveOutput === 'number'
          ? (typeof effectiveInput === 'number' ? effectiveInput : 0) +
            (typeof effectiveOutput === 'number' ? effectiveOutput : 0)
          : undefined,
    },
    context_used_percent: typeof effectiveUsed === 'number' ? effectiveUsed : undefined,
  }
}

function numberValue(value) {
  return parseTokenCount(value)
}

function parseTokenCount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().replace(/,/g, '').replace(/_/g, '')
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*([km])?(?:\s*(?:tok|tokens?))?$/i)
  if (!match) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return undefined
  const unit = match[2]?.toLowerCase()
  const multiplier = unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1
  return Math.round(amount * multiplier)
}
