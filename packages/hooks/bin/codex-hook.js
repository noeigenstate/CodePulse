#!/usr/bin/env node
/**
 * CodePulse hook for Codex CLI.
 *
 * Wire this to the Codex lifecycle hooks (SessionStart, UserPromptSubmit,
 * PreToolUse, PermissionRequest, PostToolUse, Stop). Codex passes the hook JSON
 * on stdin; we tag it with `source: 'codex'` and forward it to the local
 * server. Exits 0 unconditionally so it never blocks Codex.
 *
 * @module hooks/bin/codex-hook
 */
import { readStdinJson, postEvent } from '../lib/post.js'

const data = await readStdinJson()
await postEvent({ source: 'codex', ...data })
process.exit(0)
