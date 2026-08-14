#!/usr/bin/env node
/**
 * 面向 Codex CLI 的 CodePulse hook。
 *
 * 可接入 Codex 生命周期 hook（SessionStart、UserPromptSubmit、
 * PreToolUse、PermissionRequest、PostToolUse、Stop）。
 * Codex 通过 stdin 传入 hook JSON；本脚本打上 `source: 'codex'`
 * 标记后转发给本地服务器。无条件以 0 退出，绝不阻塞 Codex。
 *
 * @module hooks/bin/codex-hook

 */
import { readStdinJson, postEvent } from '../lib/post.js'

const data = await readStdinJson()
// Keep the host hook on the shortest path. The long-lived local server reads
// structured rollout state and official App Server quota after accepting this
// lifecycle event, so a large JSONL file never delays the Codex process.
await postEvent({ ...data, source: 'codex' })
process.exit(0)
