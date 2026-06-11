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
import { readLatestCodexUsage } from '../lib/codex-usage.js'

const data = await readStdinJson()
const usagePatch = await readLatestCodexUsage(data)
await postEvent({ source: 'codex', ...data, ...usagePatch })
process.exit(0)
