#!/usr/bin/env node
/**
 * 面向 Claude Code 的 CodePulse hook。
 *
 * 可接入任意/全部 Claude hook 事件（SessionStart、UserPromptSubmit、
 * PreToolUse、PostToolUse、Notification、Stop、SessionEnd）。
 * Claude 通过 stdin 传入 hook JSON；本脚本打上 `source: 'claude_code'`
 * 标记后转发给本地服务器。无条件以 0 退出，绝不阻塞 Claude。
 *
 * @module hooks/bin/claude-hook
 */
import { readStdinJson, postEvent } from '../lib/post.js'

const data = await readStdinJson()
await postEvent({ source: 'claude_code', ...data })
process.exit(0)
