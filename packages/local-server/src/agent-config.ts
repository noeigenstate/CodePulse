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

/** Grok 全局 hooks 写入 `~/.grok/hooks/codepulse.json` 的事件列表。 */
const GROK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const

const GROK_MATCHED_EVENTS = new Set<string>([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
  'Notification',
])

/** Kimi Code events supported by its native `[[hooks]]` configuration. */
const KIMI_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure',
  'Interrupt',
  'SessionEnd',
  'Notification',
] as const
const KIMI_BLOCK_START = '# >>> codepulse-managed >>>'
const KIMI_BLOCK_END = '# <<< codepulse-managed <<<'
const KIMI_ADDED_NEWLINE = '# codepulse-added-leading-newline'

export interface AgentConfigurationOptions {
  env?: Record<string, string | undefined>
  homeDir?: string
  hookBinDir: string
  /**
   * 本机 API 共享密钥。写入 hook 启动命令的环境变量，
   * 避免 local-server 开启认证后 statusline/hook 401 导致额度不更新。
   */
  localAuthToken?: string
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
  grok: AgentConfigurationStatus
  kimi: AgentConfigurationStatus
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

/**
 * 将当前安装目录的 hook 发布为用户主目录下的稳定入口：
 * `~/.codepulse/hooks/bin/*.js` + `~/.codepulse/hook-runtime.json`
 *
 * Claude/Codex/Grok 配置只指向稳定路径；CodePulse 每次启动更新 runtime
 * 指针，换盘/重装后无需手工改 CLI 配置。
 */
export async function publishStableHookLaunchers(
  options: AgentConfigurationOptions,
): Promise<string> {
  const home = options.homeDir ?? homedir()
  const stableBin = join(home, '.codepulse', 'hooks', 'bin')
  const runtimePath = join(home, '.codepulse', 'hook-runtime.json')
  const realBin = options.hookBinDir

  await mkdir(stableBin, { recursive: true })
  await writeText(
    runtimePath,
    `${JSON.stringify(
      {
        hookBinDir: realBin,
        updatedAt: Date.now(),
      },
      null,
      2,
    )}\n`,
  )

  for (const name of HOOK_LAUNCHER_NAMES) {
    await writeText(join(stableBin, name), buildHookLauncherScript(name))
  }
  return stableBin
}

const HOOK_LAUNCHER_NAMES = [
  'claude-hook.js',
  'claude-statusline.js',
  'codex-hook.js',
  'grok-hook.js',
  'kimi-hook.js',
] as const

/** Tiny ESM shim: read sibling hook-runtime.json and run the real install script. */
function buildHookLauncherScript(scriptName: string): string {
  // Self-contained: runtime lives at ~/.codepulse/hook-runtime.json next to hooks/.
  // Resolve relative to this file so tests can use an isolated homeDir.
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const runtimePath = join(here, '..', '..', 'hook-runtime.json')
let hookBinDir
try {
  hookBinDir = JSON.parse(readFileSync(runtimePath, 'utf8')).hookBinDir
} catch {
  console.error('[codepulse] missing hook-runtime.json — open CodePulse once to repair hooks')
  process.exit(0)
}
const target = join(String(hookBinDir), ${JSON.stringify(scriptName)})
// inherit: forward Claude's statusline stdin JSON + stdout status text.
// (Windows pipe+exit races can assert in libuv; inherit is reliable here.)
const child = spawn(process.execPath, [target], {
  stdio: 'inherit',
  windowsHide: true,
})
child.on('error', () => process.exit(0))
child.on('exit', (code, signal) => {
  if (signal) process.exit(0)
  process.exit(code ?? 0)
})
`
}

export async function configureAgents(
  options: AgentConfigurationOptions,
): Promise<AgentConfigurationResult> {
  // Publish stable launchers first so agent configs never hard-code install drive.
  const stableBin = await publishStableHookLaunchers(options)
  const resolved = { ...options, hookBinDir: stableBin }

  const [claude, codex, grok, kimi] = await Promise.all([
    configureClaudeAgent(resolved),
    configureCodexAgent(resolved),
    configureGrokAgent(resolved),
    configureKimiAgent(resolved),
  ])
  return { claude, codex, grok, kimi }
}

export async function cleanupAgents(
  options: AgentConfigurationOptions,
): Promise<AgentConfigurationResult> {
  const [claude, codex, grok, kimi] = await Promise.all([
    cleanupClaudeAgent(options),
    cleanupCodexAgent(options),
    cleanupGrokAgent(options),
    cleanupKimiAgent(options),
  ])
  return { claude, codex, grok, kimi }
}

export async function configureClaudeAgent(
  options: AgentConfigurationOptions,
): Promise<AgentConfigurationStatus> {
  const path = claudeConfigPath(options)
  const command = nodeCommand(join(options.hookBinDir, 'claude-hook.js'), options.localAuthToken)
  const statusLineCommand = nodeCommand(
    join(options.hookBinDir, 'claude-statusline.js'),
    options.localAuthToken,
  )
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
  const command = nodeCommand(join(options.hookBinDir, 'codex-hook.js'), options.localAuthToken)
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

/**
 * Build the shell command that Claude/Codex/Grok will execute for hooks.
 *
 * Auth token is intentionally NOT embedded here: nested `cmd /c "… node "path""`
 * quoting breaks on Windows and prevents statusline/hooks from running at all
 * (Claude quota then stuck on「等待命令行同步额度」while disk sync still works).
 *
 * Hooks read `~/.codepulse/local-auth` via packages/hooks/lib/post.js instead.
 * `localAuthToken` is accepted for API compatibility / future non-Windows use
 * but only injected on non-Windows where `VAR=value cmd` is reliable.
 */
function nodeCommand(scriptPath: string, localAuthToken?: string): string {
  const run = `node ${quoteArg(scriptPath)}`
  const token = localAuthToken?.trim()
  if (!token || process.platform === 'win32') return run
  return `CODEPULSE_TOKEN=${token} ${run}`
}

function quoteArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

function isCodePulseCommand(command: string, name: string): boolean {
  // Raw TOML doubles Windows separators, while parsed JSON contains one.
  // Collapse both forms before matching known CodePulse paths.
  const lower = command.toLowerCase().replace(/\\/g, '/').replace(/\/+/g, '/')
  return (
    lower.includes(name.toLowerCase()) &&
    (lower.includes('codepulse') || lower.includes('/.codepulse/hooks/')) &&
    (lower.includes('/codepulse-hooks/') ||
      lower.includes('/packages/hooks/') ||
      lower.includes('/.codepulse/hooks/') ||
      lower.includes('/hooks/bin/') ||
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

/**
 * 配置 Grok Build 全局 hooks（`~/.grok/hooks/codepulse.json`）。
 * 全局 hooks 默认受信任，无需项目级 `/hooks-trust`。
 */
export async function configureGrokAgent(
  options: AgentConfigurationOptions,
): Promise<AgentConfigurationStatus> {
  const path = grokHooksPath(options)
  const command = nodeCommand(join(options.hookBinDir, 'grok-hook.js'), options.localAuthToken)
  try {
    const before = await readTextIfExists(path)
    const hooksJson = parseJsonObject(before)
    const hooks = objectValue(hooksJson.hooks) ?? {}
    hooksJson.hooks = hooks

    for (const event of GROK_EVENTS) {
      ensureHookCommand(
        hooks,
        event,
        command,
        (candidate) => isCodePulseCommand(candidate, 'grok-hook'),
        GROK_MATCHED_EVENTS.has(event) ? '.*' : undefined,
      )
    }

    const next = `${JSON.stringify(hooksJson, null, 2)}\n`
    const changed = next !== (before ?? '')
    if (changed) await writeText(path, next)
    return { path, changed, configured: isGrokConfigured(hooksJson) }
  } catch (error) {
    return { path, changed: false, configured: false, error: errorMessage(error) }
  }
}

export async function cleanupGrokAgent(
  options: AgentConfigurationOptions,
): Promise<AgentConfigurationStatus> {
  const path = grokHooksPath(options)
  try {
    const before = await readTextIfExists(path)
    if (before == null) return { path, changed: false, configured: false }

    const hooksJson = parseJsonObject(before)
    const hooks = objectValue(hooksJson.hooks)
    if (hooks) {
      removeManagedHookCommands(hooks, 'grok-hook')
      if (Object.keys(hooks).length === 0) delete hooksJson.hooks
    }

    // CodePulse 独占的 hook 文件：清理后若无剩余 hooks 则删除文件
    const hasRemaining = hasAnyHookCommand(objectValue(hooksJson.hooks))
    if (!hasRemaining) {
      try {
        await unlink(path)
        return { path, changed: true, configured: false }
      } catch (error) {
        const code = (error as { code?: string }).code
        if (code !== 'ENOENT') throw error
        return { path, changed: before != null, configured: false }
      }
    }

    const next = `${JSON.stringify(hooksJson, null, 2)}\n`
    const changed = next !== before
    if (changed) await writeText(path, next)
    return { path, changed, configured: false }
  } catch (error) {
    return { path, changed: false, configured: false, error: errorMessage(error) }
  }
}

function isGrokConfigured(settings: JsonObject): boolean {
  const hooks = objectValue(settings.hooks)
  return !!hooks && GROK_EVENTS.every((event) => eventHasManagedCommand(hooks, event, 'grok-hook'))
}

/**
 * Installs CodePulse hooks into Kimi Code's main TOML configuration.
 *
 * A delimited block makes the operation idempotent and lets cleanup preserve
 * every user-owned setting byte-for-byte. The first edit also creates a
 * non-overwriting `.codepulse.bak` safety copy.
 *
 * @param options Hook installation paths and environment overrides.
 * @returns The resulting configuration status.
 */
export async function configureKimiAgent(
  options: AgentConfigurationOptions,
): Promise<AgentConfigurationStatus> {
  const path = kimiConfigPath(options)
  const command = nodeCommand(join(options.hookBinDir, 'kimi-hook.js'), options.localAuthToken)
  try {
    const before = (await readTextIfExists(path)) ?? ''
    const block = buildKimiManagedBlock(command)
    const withoutManagedBlock = removeKimiManagedBlock(before)
    const withoutLegacyEntries = removeCodePulseKimiHookTables(withoutManagedBlock)
    const next = replaceKimiManagedBlock(withoutLegacyEntries, block)
    const changed = next !== before
    if (changed) {
      await writeBackupOnce(path, before)
      await writeText(path, next)
    }
    return { path, changed, configured: next.includes('kimi-hook.js') }
  } catch (error) {
    return { path, changed: false, configured: false, error: errorMessage(error) }
  }
}

/**
 * Removes the current managed block and unmarked legacy CodePulse Kimi hooks.
 *
 * @param options Configuration path overrides.
 * @returns The cleanup status without modifying user-owned TOML entries.
 */
export async function cleanupKimiAgent(
  options: AgentConfigurationOptions,
): Promise<AgentConfigurationStatus> {
  const path = kimiConfigPath(options)
  try {
    const before = await readTextIfExists(path)
    if (before == null) return { path, changed: false, configured: false }
    const next = removeCodePulseKimiHookTables(removeKimiManagedBlock(before))
    const changed = next !== before
    if (changed) await writeText(path, next)
    return { path, changed, configured: false }
  } catch (error) {
    return { path, changed: false, configured: false, error: errorMessage(error) }
  }
}

/** Builds valid Kimi TOML using only the documented hook fields. */
function buildKimiManagedBlock(command: string): string {
  const entries = KIMI_EVENTS.map(
    (event) => `[[hooks]]\nevent = ${JSON.stringify(event)}\ncommand = ${JSON.stringify(command)}`,
  ).join('\n\n')
  return `${KIMI_BLOCK_START}\n${entries}\n${KIMI_BLOCK_END}`
}

/** Replaces an existing managed block or appends a new one. */
function replaceKimiManagedBlock(text: string, block: string): string {
  const start = text.indexOf(KIMI_BLOCK_START)
  const end = start >= 0 ? text.indexOf(KIMI_BLOCK_END, start) : -1
  if (start >= 0 && end >= 0) {
    const existing = text.slice(start, end + KIMI_BLOCK_END.length)
    const replacement = existing.includes(KIMI_ADDED_NEWLINE)
      ? block.replace(KIMI_BLOCK_START, `${KIMI_BLOCK_START}\n${KIMI_ADDED_NEWLINE}`)
      : block
    return `${text.slice(0, start)}${replacement}${text.slice(end + KIMI_BLOCK_END.length)}`
  }
  if (text.length === 0) return `${block}\n`
  if (text.endsWith('\n')) return `${text}${block}\n`
  const marked = block.replace(KIMI_BLOCK_START, `${KIMI_BLOCK_START}\n${KIMI_ADDED_NEWLINE}`)
  return `${text}\n${marked}\n`
}

/** Removes the managed block and only the separator inserted with it. */
function removeKimiManagedBlock(text: string): string {
  const start = text.indexOf(KIMI_BLOCK_START)
  if (start < 0) return text
  const markerEnd = text.indexOf(KIMI_BLOCK_END, start)
  if (markerEnd < 0) return text
  const managed = text.slice(start, markerEnd + KIMI_BLOCK_END.length)
  let removeStart = start
  if (managed.includes(KIMI_ADDED_NEWLINE) && start > 0 && text[start - 1] === '\n') {
    removeStart -= 1
  }
  let removeEnd = markerEnd + KIMI_BLOCK_END.length
  if (text.slice(removeEnd, removeEnd + 2) === '\r\n') removeEnd += 2
  else if (text[removeEnd] === '\n') removeEnd += 1
  return `${text.slice(0, removeStart)}${text.slice(removeEnd)}`
}

/**
 * Removes legacy unmarked Kimi hook tables installed by older CodePulse builds.
 *
 * Kimi loads every matching `[[hooks]]` table, so retaining an old table beside
 * the managed block multiplies every lifecycle event and completion notification.
 * Tables not referencing `kimi-hook.js` remain byte-for-byte unchanged.
 *
 * @param text Kimi TOML after removing the current managed block.
 * @returns TOML without legacy CodePulse Kimi hook tables.
 */
function removeCodePulseKimiHookTables(text: string): string {
  const lines = text.match(/[^\r\n]*(?:\r\n|\n|$)/g)?.filter(Boolean) ?? []
  const retained: string[] = []

  for (let index = 0; index < lines.length; ) {
    if (lines[index]?.trim() !== '[[hooks]]') {
      retained.push(lines[index]!)
      index += 1
      continue
    }

    let end = index + 1
    while (end < lines.length && !isTomlTableHeader(lines[end]!)) end += 1
    const table = lines.slice(index, end)
    if (!isCodePulseCommand(table.join(''), 'kimi-hook')) retained.push(...table)
    index = end
  }

  return retained.join('')
}

/**
 * Checks whether a TOML line begins a standard or array table.
 *
 * @param line One source line, optionally including its newline terminator.
 * @returns Whether the line is a TOML table header.
 */
function isTomlTableHeader(line: string): boolean {
  return /^\s*\[{1,2}[^\]\r\n]+\]{1,2}\s*(?:#.*)?$/.test(line.trimEnd())
}

/** Writes the original config once without replacing a previous safety copy. */
async function writeBackupOnce(path: string, original: string): Promise<void> {
  if (!original) return
  const backupPath = `${path}.codepulse.bak`
  await mkdir(dirname(backupPath), { recursive: true })
  try {
    await writeFile(backupPath, original, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

function codexHooksPath(options: Pick<AgentConfigurationOptions, 'env' | 'homeDir'>): string {
  const env = options.env ?? process.env
  return (
    env['CODEPULSE_CODEX_HOOKS_FILE'] ?? join(options.homeDir ?? homedir(), '.codex', 'hooks.json')
  )
}

function grokHooksPath(options: Pick<AgentConfigurationOptions, 'env' | 'homeDir'>): string {
  const env = options.env ?? process.env
  return (
    env['CODEPULSE_GROK_HOOKS_FILE'] ??
    join(options.homeDir ?? homedir(), '.grok', 'hooks', 'codepulse.json')
  )
}

/** Resolves Kimi Code's main config, honoring test and installation overrides. */
function kimiConfigPath(options: Pick<AgentConfigurationOptions, 'env' | 'homeDir'>): string {
  const env = options.env ?? process.env
  const home = options.homeDir ?? homedir()
  return (
    env['CODEPULSE_KIMI_CONFIG_FILE'] ??
    join(env['KIMI_CODE_HOME'] ?? join(home, '.kimi-code'), 'config.toml')
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
