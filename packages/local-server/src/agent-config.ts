import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const CLAUDE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
] as const

const CODEX_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
] as const

const CODEX_MATCHED_EVENTS = new Set<string>(['PreToolUse', 'PermissionRequest', 'PostToolUse'])

export interface AgentConfigurationOptions {
  env?: Record<string, string | undefined>
  homeDir?: string
  hookBinDir: string
}

export interface AgentConfigurationStatus {
  changed: boolean
  configured: boolean
  path: string
  error?: string
}

export interface AgentConfigurationResult {
  claude: AgentConfigurationStatus
  codex: AgentConfigurationStatus
}

interface JsonObject {
  [key: string]: unknown
}

interface HookGroup {
  matcher?: string
  hooks?: HookCommand[]
  [key: string]: unknown
}

interface HookCommand {
  type?: string
  command?: string
  [key: string]: unknown
}

export async function configureAgents(
  options: AgentConfigurationOptions,
): Promise<AgentConfigurationResult> {
  const [claude, codex] = await Promise.all([
    configureClaudeAgent(options),
    configureCodexAgent(options),
  ])
  return { claude, codex }
}

export async function cleanupAgents(
  options: AgentConfigurationOptions,
): Promise<AgentConfigurationResult> {
  const [claude, codex] = await Promise.all([
    cleanupClaudeAgent(options),
    cleanupCodexAgent(options),
  ])
  return { claude, codex }
}

export async function configureClaudeAgent(
  options: AgentConfigurationOptions,
): Promise<AgentConfigurationStatus> {
  const path = claudeConfigPath(options)
  const command = nodeCommand(join(options.hookBinDir, 'claude-hook.js'))
  const statusLineCommand = nodeCommand(join(options.hookBinDir, 'claude-statusline.js'))
  try {
    const before = await readTextIfExists(path)
    const settings = parseJsonObject(before)
    const hooks = objectValue(settings.hooks) ?? {}
    settings.hooks = hooks

    for (const event of CLAUDE_EVENTS) {
      ensureHookCommand(hooks, event, command, (candidate) =>
        isCodePulseCommand(candidate, 'claude-hook'),
      )
    }

    const existingStatusLine = objectValue(settings.statusLine)
    const existingCommand =
      existingStatusLine && typeof existingStatusLine.command === 'string'
        ? existingStatusLine.command
        : undefined
    if (!existingCommand || isCodePulseCommand(existingCommand, 'claude-statusline')) {
      settings.statusLine = { type: 'command', command: statusLineCommand }
    }

    const next = `${JSON.stringify(settings, null, 2)}\n`
    const changed = next !== (before ?? '')
    if (changed) await writeText(path, next)
    return { path, changed, configured: isClaudeConfigured(settings) }
  } catch (error) {
    return { path, changed: false, configured: false, error: errorMessage(error) }
  }
}

export async function cleanupClaudeAgent(
  options: AgentConfigurationOptions,
): Promise<AgentConfigurationStatus> {
  const path = claudeConfigPath(options)
  try {
    const before = await readTextIfExists(path)
    if (before == null) return { path, changed: false, configured: false }

    const settings = parseJsonObject(before)
    const hooks = objectValue(settings.hooks)
    if (hooks) {
      removeManagedHookCommands(hooks, 'claude-hook')
      if (Object.keys(hooks).length === 0) delete settings.hooks
    }

    const statusLine = objectValue(settings.statusLine)
    const statusLineCommand = typeof statusLine?.command === 'string' ? statusLine.command : ''
    if (isCodePulseCommand(statusLineCommand, 'claude-statusline')) delete settings.statusLine

    const next = `${JSON.stringify(settings, null, 2)}\n`
    const changed = next !== before
    if (changed) await writeText(path, next)
    return { path, changed, configured: false }
  } catch (error) {
    return { path, changed: false, configured: false, error: errorMessage(error) }
  }
}

export async function configureCodexAgent(
  options: AgentConfigurationOptions,
): Promise<AgentConfigurationStatus> {
  const hooksPath = codexHooksPath(options)
  const configPath = codexConfigPath(options)
  const command = nodeCommand(join(options.hookBinDir, 'codex-hook.js'))
  try {
    const beforeHooks = await readTextIfExists(hooksPath)
    const hooksJson = parseJsonObject(beforeHooks)
    const hooks = objectValue(hooksJson.hooks) ?? {}
    hooksJson.hooks = hooks

    for (const event of CODEX_EVENTS) {
      ensureHookCommand(
        hooks,
        event,
        command,
        (candidate) => isCodePulseCommand(candidate, 'codex-hook'),
        CODEX_MATCHED_EVENTS.has(event) ? '*' : undefined,
      )
    }

    const nextHooks = `${JSON.stringify(hooksJson, null, 2)}\n`
    const hooksChanged = nextHooks !== (beforeHooks ?? '')
    if (hooksChanged) await writeText(hooksPath, nextHooks)

    const beforeConfig = await readTextIfExists(configPath)
    const nextConfig = ensureTomlFeatureEnabled(beforeConfig ?? '')
    const configChanged = nextConfig !== (beforeConfig ?? '')
    if (configChanged) await writeText(configPath, nextConfig)

    return {
      path: hooksPath,
      changed: hooksChanged || configChanged,
      configured: isCodexConfigured(hooksJson),
    }
  } catch (error) {
    return { path: hooksPath, changed: false, configured: false, error: errorMessage(error) }
  }
}

export async function cleanupCodexAgent(
  options: AgentConfigurationOptions,
): Promise<AgentConfigurationStatus> {
  const hooksPath = codexHooksPath(options)
  const configPath = codexConfigPath(options)
  try {
    const beforeHooks = await readTextIfExists(hooksPath)
    let hooksChanged = false
    let hasRemainingHooks = true
    if (beforeHooks != null) {
      const hooksJson = parseJsonObject(beforeHooks)
      const hooks = objectValue(hooksJson.hooks)
      if (hooks) {
        removeManagedHookCommands(hooks, 'codex-hook')
        if (Object.keys(hooks).length === 0) delete hooksJson.hooks
      }
      hasRemainingHooks = hasAnyHookCommand(objectValue(hooksJson.hooks))
      const nextHooks = `${JSON.stringify(hooksJson, null, 2)}\n`
      hooksChanged = nextHooks !== beforeHooks
      if (hooksChanged) await writeText(hooksPath, nextHooks)
    }

    const beforeConfig = await readTextIfExists(configPath)
    let configChanged = false
    if (beforeConfig != null && !hasRemainingHooks) {
      const nextConfig = disableTomlHooksFeature(beforeConfig)
      configChanged = nextConfig !== beforeConfig
      if (configChanged) await writeText(configPath, nextConfig)
    }

    return {
      path: hooksPath,
      changed: hooksChanged || configChanged,
      configured: false,
    }
  } catch (error) {
    return { path: hooksPath, changed: false, configured: false, error: errorMessage(error) }
  }
}

function ensureHookCommand(
  hooks: JsonObject,
  event: string,
  command: string,
  isManagedCommand: (command: string) => boolean,
  matcher?: string,
): void {
  const groups = Array.isArray(hooks[event])
    ? ([...(hooks[event] as HookGroup[])] as HookGroup[])
    : []
  let target = groups.find((group) => hookMatcherMatches(group.matcher, matcher))
  if (!target) {
    target = matcher == null ? { hooks: [] } : { matcher, hooks: [] }
    groups.push(target)
  }

  for (const group of groups) {
    const commands = Array.isArray(group.hooks) ? group.hooks : []
    group.hooks = commands.filter((hook) => {
      if (hook.command === command) return false
      return typeof hook.command === 'string' ? !isManagedCommand(hook.command) : true
    })
  }

  const targetHooks = Array.isArray(target.hooks) ? target.hooks : []
  if (!targetHooks.some((hook) => hook.command === command)) {
    targetHooks.push({ type: 'command', command })
  }
  target.hooks = targetHooks
  hooks[event] = groups.filter((group) => Array.isArray(group.hooks) && group.hooks.length > 0)
}

function isClaudeConfigured(settings: JsonObject): boolean {
  const hooks = objectValue(settings.hooks)
  const statusLine = objectValue(settings.statusLine)
  const statusLineCommand = typeof statusLine?.command === 'string' ? statusLine.command : ''
  return (
    !!hooks &&
    CLAUDE_EVENTS.every((event) => eventHasManagedCommand(hooks, event, 'claude-hook')) &&
    isCodePulseCommand(statusLineCommand, 'claude-statusline')
  )
}

function isCodexConfigured(settings: JsonObject): boolean {
  const hooks = objectValue(settings.hooks)
  return (
    !!hooks && CODEX_EVENTS.every((event) => eventHasManagedCommand(hooks, event, 'codex-hook'))
  )
}

function eventHasManagedCommand(hooks: JsonObject, event: string, name: string): boolean {
  const groups = hooks[event]
  if (!Array.isArray(groups)) return false
  return groups.some((group) =>
    Array.isArray((group as HookGroup).hooks)
      ? (group as HookGroup).hooks?.some(
          (hook) => typeof hook.command === 'string' && isCodePulseCommand(hook.command, name),
        )
      : false,
  )
}

function removeManagedHookCommands(hooks: JsonObject, name: string): void {
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue
    const groups = (value as HookGroup[])
      .map((group) => {
        const commands = Array.isArray(group.hooks) ? group.hooks : []
        return {
          ...group,
          hooks: commands.filter((hook) =>
            typeof hook.command === 'string' ? !isCodePulseCommand(hook.command, name) : true,
          ),
        }
      })
      .filter((group) => Array.isArray(group.hooks) && group.hooks.length > 0)
    if (groups.length > 0) {
      hooks[event] = groups
    } else {
      delete hooks[event]
    }
  }
}

function hasAnyHookCommand(hooks: JsonObject | undefined): boolean {
  if (!hooks) return false
  return Object.values(hooks).some(
    (value) =>
      Array.isArray(value) &&
      value.some(
        (group) =>
          Array.isArray((group as HookGroup).hooks) &&
          ((group as HookGroup).hooks?.length ?? 0) > 0,
      ),
  )
}

function ensureTomlFeatureEnabled(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.length > 0 ? normalized.split('\n') : []
  let featuresStart = -1
  let featuresEnd = lines.length
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim()
    if (line === '[features]') {
      featuresStart = index
      continue
    }
    if (featuresStart >= 0 && index > featuresStart && line?.startsWith('[')) {
      featuresEnd = index
      break
    }
  }

  if (featuresStart < 0) {
    const prefix = normalized.trim().length > 0 ? `${normalized.replace(/\n*$/, '')}\n\n` : ''
    return `${prefix}[features]\nhooks = true\n`
  }

  for (let index = featuresStart + 1; index < featuresEnd; index += 1) {
    if (/^\s*hooks\s*=/.test(lines[index] ?? '')) {
      lines[index] = 'hooks = true'
      return `${lines.join('\n').replace(/\n*$/, '')}\n`
    }
  }

  lines.splice(featuresStart + 1, 0, 'hooks = true')
  return `${lines.join('\n').replace(/\n*$/, '')}\n`
}

function disableTomlHooksFeature(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.length > 0 ? normalized.split('\n') : []
  let featuresStart = -1
  let featuresEnd = lines.length
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim()
    if (line === '[features]') {
      featuresStart = index
      continue
    }
    if (featuresStart >= 0 && index > featuresStart && line?.startsWith('[')) {
      featuresEnd = index
      break
    }
  }

  if (featuresStart < 0) return text

  for (let index = featuresStart + 1; index < featuresEnd; index += 1) {
    if (/^\s*hooks\s*=/.test(lines[index] ?? '')) {
      lines[index] = 'hooks = false'
      return `${lines.join('\n').replace(/\n*$/, '')}\n`
    }
  }

  return text
}

function parseJsonObject(text: string | undefined): JsonObject {
  if (!text || text.trim().length === 0) return {}
  const value = JSON.parse(text) as unknown
  return objectValue(value) ?? {}
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

function hookMatcherMatches(groupMatcher: unknown, matcher: string | undefined): boolean {
  const normalizedGroupMatcher =
    typeof groupMatcher === 'string' && groupMatcher.trim() ? groupMatcher : undefined
  return normalizedGroupMatcher === matcher
}

function nodeCommand(scriptPath: string): string {
  return `node ${quoteArg(scriptPath)}`
}

function quoteArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

function isCodePulseCommand(command: string, name: string): boolean {
  const lower = command.toLowerCase().replace(/\\/g, '/')
  return (
    lower.includes(name.toLowerCase()) &&
    lower.includes('codepulse') &&
    (lower.includes('/codepulse-hooks/') ||
      lower.includes('/packages/hooks/') ||
      lower.includes('/hooks/'))
  )
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return undefined
    throw error
  }
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.codepulse-${process.pid}-${Date.now()}.tmp`
  try {
    await writeFile(tempPath, text, 'utf8')
    await rename(tempPath, path)
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
}

function codexHooksPath(options: Pick<AgentConfigurationOptions, 'env' | 'homeDir'>): string {
  const env = options.env ?? process.env
  return (
    env['CODEPULSE_CODEX_HOOKS_FILE'] ?? join(options.homeDir ?? homedir(), '.codex', 'hooks.json')
  )
}

function codexConfigPath(options: Pick<AgentConfigurationOptions, 'env' | 'homeDir'>): string {
  const env = options.env ?? process.env
  return (
    env['CODEPULSE_CODEX_CONFIG_FILE'] ??
    join(options.homeDir ?? homedir(), '.codex', 'config.toml')
  )
}

function claudeConfigPath(options: Pick<AgentConfigurationOptions, 'env' | 'homeDir'>): string {
  const env = options.env ?? process.env
  return (
    env['CODEPULSE_CLAUDE_CONFIG_FILE'] ??
    join(options.homeDir ?? homedir(), '.claude', 'settings.json')
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
