#!/usr/bin/env node
/**
 * CodePulse status-line collector for Claude Code.
 *
 * Configure as Claude's `statusLine.command`. Claude pipes session JSON (model,
 * workspace, cost, token usage, context %) on stdin and expects a single status
 * line on stdout.
 *
 * This script does double duty: it forwards the token/context data to CodePulse
 * AND prints a compact status line for Claude to display. Forwarding is
 * best-effort and time-bounded (~600ms) so it never slows down the prompt.
 *
 * @module hooks/bin/claude-statusline
 */
import { readStdinJson, postEvent } from '../lib/post.js'

const data = await readStdinJson()

// Best-effort forward — don't let it delay the status line beyond ~600ms.
await postEvent({ source: 'claude_code', channel: 'statusline', ...data }, { timeoutMs: 600 })

const model = data?.model?.display_name ?? data?.model?.id ?? 'Claude'
const dir = data?.workspace?.current_dir ?? data?.cwd ?? ''
const dirName = dir ? dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : ''
const ctx = data?.context_used_percent ?? data?.usage?.context_used_percent
const ctxText = typeof ctx === 'number' ? ` · ctx ${Math.round(ctx)}%` : ''

process.stdout.write(`⏺ ${model}${dirName ? ` · ${dirName}` : ''}${ctxText}`)
process.exit(0)
