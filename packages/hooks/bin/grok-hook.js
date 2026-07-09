#!/usr/bin/env node
/**
 * 面向 Grok Build CLI 的 CodePulse hook。
 *
 * 可接入 Grok 生命周期 hook（SessionStart、UserPromptSubmit、
 * PreToolUse、PostToolUse、Stop、Notification、SessionEnd 等）。
 * Grok 通过 stdin 传入 hook JSON；本脚本打上 `source: 'grok'`
 * 标记后转发给本地服务器。无条件以 0 退出，绝不阻塞 Grok。
 *
 * @module hooks/bin/grok-hook
 */
import { readStdinJson, postEvent } from '../lib/post.js'

const data = await readStdinJson()
await postEvent({ source: 'grok', ...data })
process.exit(0)
