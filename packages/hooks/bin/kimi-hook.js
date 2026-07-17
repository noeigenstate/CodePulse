#!/usr/bin/env node
/**
 * Forwards Kimi Code lifecycle hooks to the local CodePulse server.
 *
 * @module hooks/bin/kimi-hook
 */
import { readLatestKimiUsage } from '../lib/kimi-usage.js'
import { postEvent, readStdinJson } from '../lib/post.js'

const raw = await readStdinJson()
const usage = await readLatestKimiUsage(raw)
await postEvent({ ...raw, ...usage, source: 'kimi' })
process.exit(0)
