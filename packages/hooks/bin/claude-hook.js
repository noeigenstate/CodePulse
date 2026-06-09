#!/usr/bin/env node
/**
 * CodePulse hook for Claude Code.
 *
 * Wire this to any/all Claude hook events (SessionStart, UserPromptSubmit,
 * PreToolUse, PostToolUse, Notification, Stop, SessionEnd). Claude passes the
 * hook JSON on stdin; we tag it with `source: 'claude_code'` and forward it to
 * the local server. Exits 0 unconditionally so it never blocks Claude.
 *
 * @module hooks/bin/claude-hook
 */
import { readStdinJson, postEvent } from '../lib/post.js'

const data = await readStdinJson()
await postEvent({ source: 'claude_code', ...data })
process.exit(0)
