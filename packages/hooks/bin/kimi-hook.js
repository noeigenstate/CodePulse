#!/usr/bin/env node
/**
 * Forwards Kimi Code lifecycle hooks to the local CodePulse server.
 *
 * @module hooks/bin/kimi-hook
 */
import { readLatestKimiUsage } from '../lib/kimi-usage.js'
import { postEvent, readStdinJson, withAgentSource } from '../lib/post.js'

const raw = await readStdinJson()
const usage = await readLatestKimiUsage(raw)
await postEvent(withAgentSource('kimi', raw, usage))
process.exit(0)
