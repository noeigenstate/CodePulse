import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import {
  DEFAULT_WORK_VOICE,
  type WorkVoiceSettings,
  type WorkVoiceTarget,
  type WorkVoicePreferences,
} from '@codepulse/shared'

export function normalizeWorkVoice(value: unknown): WorkVoiceSettings {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    enabled: input.enabled === true,
    intervention: typeof input.intervention === 'boolean' ? input.intervention : true,
    failures: typeof input.failures === 'boolean' ? input.failures : true,
  }
}

export function readWorkVoice(path: string): WorkVoiceSettings {
  try {
    return normalizeWorkVoice(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return { ...DEFAULT_WORK_VOICE }
  }
}

export function writeWorkVoice(path: string, value: unknown): WorkVoiceSettings {
  const settings = normalizeWorkVoice(value)
  writeFileSync(path + '.tmp', JSON.stringify(settings) + '\n', { mode: 0o600 })
  renameSync(path + '.tmp', path)
  return settings
}

export function readWorkVoiceTargets(path: string): WorkVoicePreferences {
  let raw: Record<string, unknown> = {}
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) ?? {}
  } catch {
    /* new profile */
  }
  return {
    version: 2,
    desktop: normalizeWorkVoice(raw.version === 2 ? raw.desktop : raw),
    ink: normalizeWorkVoice(raw.version === 2 ? raw.ink : undefined),
  }
}
export function writeWorkVoiceTarget(
  path: string,
  target: WorkVoiceTarget,
  value: unknown,
): WorkVoicePreferences {
  const config = readWorkVoiceTargets(path)
  config[target] = normalizeWorkVoice(value)
  writeFileSync(path + '.tmp', JSON.stringify(config) + '\n', { mode: 0o600 })
  renameSync(path + '.tmp', path)
  return config
}
