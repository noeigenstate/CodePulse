#!/usr/bin/env node
import { postEvent, readStdinJson } from '../lib/post.js'

// Hooks do not include their event name; the managed command supplies it.
const event = process.argv[2]
const response = event === 'PreToolUse' || event === 'Stop' ? { decision: 'allow' } : {}
try {
  const raw = await readStdinJson()
  // Only observation metadata leaves this process. No tool arguments, transcript,
  // prompts, permission overrides or injected steps are forwarded.
  await postEvent({ source: 'antigravity', hook_event_name: event,
    conversationId: raw?.conversationId, workspacePaths: raw?.workspacePaths,
    modelName: raw?.modelName, invocationNum: raw?.invocationNum,
    toolCall: { name: raw?.toolCall?.name }, fullyIdle: raw?.fullyIdle,
    terminationReason: raw?.terminationReason, error: Boolean(raw?.error),
  }, { timeoutMs: 500, retries: 0 })
} catch { /* Observability must never block the host agent. */ }
// 'allow' delegates to normal policy and allows stopping; never auto_approve/continue.
process.stdout.write(JSON.stringify(response) + '\n')
