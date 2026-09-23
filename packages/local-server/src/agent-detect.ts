/**
 * 本地 agent 安装/配置检测。这些探测是尽力而为的，只读取本地
 * 配置/CLI 元数据，绝不修改 agent 设置。
 *
 * @module local-server/agent-detect

 */
import { access, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import { execFile } from 'node:child_process'
import type { Agent } from '@codepulse/shared'

/** 运行本地 CLI 探测的结果。 */
export interface CommandResult {
  ok: boolean
  stdout?: string
}

/** 本地 agent 检测的测试注入点。 */
export interface AgentDetectOptions {
  env?: Record<string, string | undefined>
  homeDir?: string
  platform?: NodeJS.Platform
  runCommand?: (command: string, args: string[]) => Promise<CommandResult>
}

/** 检测 CodePulse 当前知道如何探测的所有 agent。

 * @param options Configuration and dependency overrides.
 * @returns Promise resolving to detection records for every supported CLI.
*/
export async function detectAgents(options: AgentDetectOptions = {}): Promise<Agent[]> {
  return [
    await detectClaudeAgent(options),
    await detectCodexAgent(options),
    await detectGrokAgent(options),
    await detectKimiAgent(options),
    await detectOpencodeAgent(options),
  ]
}

/**
 * Detects the OpenCode CLI and its local session database.
 *
 * OpenCode has no CodePulse hook; `opencode.db` in its data directory is the
 * data source, so a present database counts as configured.
 *
 * @param options Configuration and dependency overrides.
 * @returns Promise resolving to OpenCode installation and data-source status.
 */
export async function detectOpencodeAgent(options: AgentDetectOptions = {}): Promise<Agent> {
  const env = options.env ?? process.env
  const runCommand = options.runCommand ?? createLocalCommandRunner(options)
  const versionResult = await runFirstAvailableCommand(
    env['OPENCODE_CLI_PATH']
      ? [env['OPENCODE_CLI_PATH']]
      : await commandCandidates('opencode', options),
    ['--version'],
    runCommand,
  )
  const dataDir =
    env['OPENCODE_DATA_DIR'] ?? join(options.homeDir ?? homedir(), '.local', 'share', 'opencode')
  const configured = await access(join(dataDir, 'opencode.db')).then(
    () => true,
    () => false,
  )

  return {
    id: 'opencode',
    type: 'opencode',
    name: 'OpenCode',
    installed: versionResult.ok || configured,
    configured,
    version: versionResult.ok ? cleanVersion(versionResult.stdout) : undefined,
  }
}

/**
 * 检测 Codex CLI 是否存在，以及 Codex 配置文件中是否出现
 * CodePulse 的 hook。


 * @param options Configuration and dependency overrides.
 * @returns Promise resolving to Codex installation and hook status.
*/
export async function detectCodexAgent(options: AgentDetectOptions = {}): Promise<Agent> {
  const env = options.env ?? process.env
  const runCommand = options.runCommand ?? createLocalCommandRunner(options)
  const configPath = codexConfigPath(options)
  const hooksPath = codexHooksPath(options)

  const versionResult = await runFirstAvailableCommand(
    env['CODEX_CLI_PATH'] ? [env['CODEX_CLI_PATH']] : await commandCandidates('codex', options),
    ['--version'],
    runCommand,
  )
  const configured =
    (await fileContainsAny(hooksPath, ['codex-hook.js', 'codepulse-codex-hook'])) ||
    (await fileContainsAny(configPath, ['codex-hook.js', 'codepulse-codex-hook']))

  return {
    id: 'codex',
    type: 'codex',
    name: 'Codex',
    installed: versionResult.ok,
    configured,
    version: versionResult.ok ? cleanVersion(versionResult.stdout) : undefined,
  }
}

/** 检测 Claude Code CLI 及 CodePulse 的 hook/status-line 配置。


 * @param options Configuration and dependency overrides.
 * @returns Promise resolving to Claude installation and integration status.
*/
export async function detectClaudeAgent(options: AgentDetectOptions = {}): Promise<Agent> {
  const env = options.env ?? process.env
  const runCommand = options.runCommand ?? createLocalCommandRunner(options)
  const configPath = claudeConfigPath(options)

  const versionResult = await runFirstAvailableCommand(
    env['CLAUDE_CLI_PATH'] ? [env['CLAUDE_CLI_PATH']] : await commandCandidates('claude', options),
    ['--version'],
    runCommand,
  )
  const configured = await fileContainsAny(configPath, [
    'claude-hook.js',
    'claude-statusline.js',
    'codepulse-claude-hook',
    'codepulse-claude-statusline',
  ])

  return {
    id: 'claude_code',
    type: 'claude_code',
    name: 'Claude Code',
    installed: versionResult.ok,
    configured,
    version: versionResult.ok ? cleanVersion(versionResult.stdout) : undefined,
  }
}

/** 检测 Grok Build CLI 及 CodePulse 的全局 hook 配置。

 * @param options Configuration and dependency overrides.
 * @returns Promise resolving to Grok installation and hook status.
*/
export async function detectGrokAgent(options: AgentDetectOptions = {}): Promise<Agent> {
  const env = options.env ?? process.env
  const runCommand = options.runCommand ?? createLocalCommandRunner(options)
  const hooksPath = grokHooksPath(options)

  const versionResult = await runFirstAvailableCommand(
    env['GROK_CLI_PATH'] ? [env['GROK_CLI_PATH']] : await commandCandidates('grok', options),
    ['--version'],
    runCommand,
  )
  const configured = await fileContainsAny(hooksPath, ['grok-hook.js', 'codepulse-grok-hook'])

  return {
    id: 'grok',
    type: 'grok',
    name: 'Grok',
    installed: versionResult.ok,
    configured,
    version: versionResult.ok ? cleanVersion(versionResult.stdout) : undefined,
  }
}

/** Detects Kimi Code and the CodePulse-managed hook block in its main config.

 * @param options Configuration and dependency overrides.
 * @returns Promise resolving to Kimi installation and hook status.
*/
export async function detectKimiAgent(options: AgentDetectOptions = {}): Promise<Agent> {
  const env = options.env ?? process.env
  const runCommand = options.runCommand ?? createLocalCommandRunner(options)
  const home = options.homeDir ?? homedir()
  const kimiHome = env['KIMI_CODE_HOME'] ?? join(home, '.kimi-code')
  const configPath = env['CODEPULSE_KIMI_CONFIG_FILE'] ?? join(kimiHome, 'config.toml')
  const candidates = env['KIMI_CLI_PATH']
    ? [env['KIMI_CLI_PATH']]
    : [
        join(
          kimiHome,
          'bin',
          (options.platform ?? process.platform) === 'win32' ? 'kimi.exe' : 'kimi',
        ),
        ...(await commandCandidates('kimi', options)),
      ]
  const versionResult = await runFirstAvailableCommand(candidates, ['--version'], runCommand)
  const configured = await fileContainsAny(configPath, ['kimi-hook.js', 'codepulse-kimi-hook'])

  return {
    id: 'kimi',
    type: 'kimi',
    name: 'Kimi Code',
    installed: versionResult.ok,
    configured,
    version: versionResult.ok ? cleanVersion(versionResult.stdout) : undefined,
  }
}

/** 解析 Codex 配置文件路径（环境变量可覆盖，默认 `~/.codex/config.toml`）。

 * @param options Configuration and dependency overrides.
 * @returns Resolved Codex configuration path.
*/
function codexConfigPath(options: AgentDetectOptions): string {
  const env = options.env ?? process.env
  return (
    env['CODEPULSE_CODEX_CONFIG_FILE'] ??
    join(options.homeDir ?? homedir(), '.codex', 'config.toml')
  )
}

/**
 * Computes codex hooks path.
 * @param options Configuration and dependency overrides.
 * @returns Resolved Codex hooks path.
 */
function codexHooksPath(options: AgentDetectOptions): string {
  const env = options.env ?? process.env
  return (
    env['CODEPULSE_CODEX_HOOKS_FILE'] ?? join(options.homeDir ?? homedir(), '.codex', 'hooks.json')
  )
}

/** 解析 Claude 配置文件路径（环境变量可覆盖，默认 `~/.claude/settings.json`）。

 * @param options Configuration and dependency overrides.
 * @returns Resolved Claude settings path.
*/
function claudeConfigPath(options: AgentDetectOptions): string {
  const env = options.env ?? process.env
  return (
    env['CODEPULSE_CLAUDE_CONFIG_FILE'] ??
    join(options.homeDir ?? homedir(), '.claude', 'settings.json')
  )
}

/** 解析 Grok CodePulse hook 文件路径（默认 `~/.grok/hooks/codepulse.json`）。

 * @param options Configuration and dependency overrides.
 * @returns Resolved Grok hook configuration path.
*/
function grokHooksPath(options: AgentDetectOptions): string {
  const env = options.env ?? process.env
  return (
    env['CODEPULSE_GROK_HOOKS_FILE'] ??
    join(options.homeDir ?? homedir(), '.grok', 'hooks', 'codepulse.json')
  )
}

/** 判断文件是否包含任一关键字（不区分大小写）；文件不存在时返回 false。

 * @param path Filesystem path to inspect.
 * @param needles Candidate strings matched case-insensitively.
 * @returns Promise resolving to whether the file contains any candidate string.
*/
async function fileContainsAny(path: string, needles: string[]): Promise<boolean> {
  try {
    await access(path)
    const text = await readFile(path, 'utf8')
    const lower = text.toLowerCase()
    return needles.some((needle) => lower.includes(needle.toLowerCase()))
  } catch {
    return false
  }
}

/** 取版本输出的首行作为版本字符串。

 * @param stdout Command output to parse.
 * @returns First non-empty version output line.
*/
function cleanVersion(stdout: string | undefined): string | undefined {
  const text = stdout?.trim()
  return text ? text.split(/\r?\n/)[0] : undefined
}

/**
 * Build candidate executables for a CLI name.
 *
 * On macOS/Linux, GUI apps (Finder / Dock / DMG) inherit a minimal PATH and
 * miss Homebrew / nvm / npm-global shims. Probe absolute paths under common
 * bin directories in addition to the bare command name.


 * @param command Executable or command name.
 * @param options Configuration and dependency overrides.
 * @returns Promise resolving to executable candidates in probe order.
*/
export async function commandCandidates(
  command: string,
  options: AgentDetectOptions = {},
): Promise<string[]> {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    return [`${command}.cmd`, command, `${command}.exe`]
  }

  const home = options.homeDir ?? homedir()
  const env = options.env ?? process.env
  const dirs = await commonBinDirectories(home, env, platform)
  const absolute = dirs.map((dir) => pathJoin(platform, dir, command))
  // Bare name first (with augmented PATH in the runner), then fixed locations.
  return uniqueStrings([command, ...absolute])
}

/** Exported for tests — directories prepended onto PATH for CLI probes.


 * @param home User home directory.
 * @param env Process environment.
 * @param platform Target operating system.
 * @returns Promise resolving to user-level CLI directories in probe order.
*/
export async function commonBinDirectories(
  home: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  const p = (...parts: string[]) => pathJoin(platform, ...parts)
  const dirs = [
    p('/opt/homebrew/bin'),
    p('/opt/homebrew/sbin'),
    p('/usr/local/bin'),
    p('/usr/local/sbin'),
    p(home, '.local', 'bin'),
    p(home, '.npm-global', 'bin'),
    p(home, '.yarn', 'bin'),
    p(home, '.volta', 'bin'),
    p(home, '.fnm', 'current', 'bin'),
    p(home, '.cargo', 'bin'),
    p(home, 'Library', 'pnpm'),
    p(home, '.local', 'share', 'pnpm'),
  ]

  // nvm: ~/.nvm/versions/node/<ver>/bin
  const nvmRoot = env['NVM_DIR'] ?? p(home, '.nvm')
  const nvmVersions = p(nvmRoot, 'versions', 'node')
  try {
    const versions = await readdir(nvmVersions)
    for (const version of versions) {
      dirs.push(p(nvmVersions, version, 'bin'))
    }
  } catch {
    // nvm not installed
  }

  // asdf shims
  dirs.push(p(home, '.asdf', 'shims'))

  // Existing PATH entries last so system / user PATH still participates.
  const sep = platform === 'win32' ? ';' : ':'
  const pathDirs = (env['PATH'] ?? '')
    .split(sep)
    .map((part) => part.trim())
    .filter(Boolean)
  dirs.push(...pathDirs)

  return uniqueStrings(dirs)
}

/**
 * Builds the PATH used by local CLI probes and App Server child processes.
 *
 * @param home User home directory used to resolve common package-manager bins.
 * @param env Environment containing the inherited PATH value.
 * @param platform Target operating system whose path syntax should be used.
 * @returns PATH with common user-level CLI locations prepended.

 */
export function buildAugmentedPath(
  home: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    return (
      env['PATH'] ?? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
    )
  }
  const sep = ':'
  // Synchronous subset for PATH — nvm versions are added via absolute candidates.
  const p = (...parts: string[]) => pathJoin(platform, ...parts)
  const staticDirs = [
    p('/opt/homebrew/bin'),
    p('/opt/homebrew/sbin'),
    p('/usr/local/bin'),
    p('/usr/local/sbin'),
    p(home, '.local', 'bin'),
    p(home, '.npm-global', 'bin'),
    p(home, '.yarn', 'bin'),
    p(home, '.volta', 'bin'),
    p(home, '.fnm', 'current', 'bin'),
    p(home, '.cargo', 'bin'),
    p(home, 'Library', 'pnpm'),
    p(home, '.local', 'share', 'pnpm'),
    p(home, '.asdf', 'shims'),
  ]
  return uniqueStrings([...staticDirs, ...(env['PATH'] ?? '').split(sep).filter(Boolean)]).join(sep)
}

/**
 * Join path segments for the *target* platform.
 * When unit tests on Windows simulate darwin, Node's path.join would otherwise
 * turn `/opt/homebrew` into `\opt\homebrew` and break absolute Unix paths.


 * @param platform Target operating system.
 * @param segments Path segments to join.
 * @returns Path joined with the target platform syntax.
*/
function pathJoin(platform: NodeJS.Platform, ...segments: string[]): string {
  return platform === 'win32' ? join(...segments) : posix.join(...segments)
}

/**
 * Computes unique strings.
 * @param values Values to process.
 * @returns Non-empty values with duplicates removed.
 */
function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * Computes run first available command.
 * @param commands Executable candidates in probe order.
 * @param args Command arguments.
 * @param runCommand Run command.
 * @returns Promise resolving to the first successful command result or the final failure.
 */
async function runFirstAvailableCommand(
  commands: string[],
  args: string[],
  runCommand: (command: string, args: string[]) => Promise<CommandResult>,
): Promise<CommandResult> {
  for (const command of commands) {
    const result = await runCommand(command, args)
    if (result.ok) return result
  }
  return { ok: false }
}

/**
 * Creates local command runner.
 * @param options Configuration and dependency overrides.
 * @returns Command runner configured with the augmented child environment.
 */
function createLocalCommandRunner(
  options: AgentDetectOptions,
): (command: string, args: string[]) => Promise<CommandResult> {
  const env = options.env ?? process.env
  const home = options.homeDir ?? homedir()
  const platform = options.platform ?? process.platform
  const path = buildAugmentedPath(home, env, platform)
  const childEnv = { ...env, PATH: path }

  return (command, args) => runLocalCommand(command, args, childEnv, platform)
}

/** 以 1.5 秒超时执行本地命令；从不抛出，失败时 `ok: false`。

 * @param command Executable or command name.
 * @param args Command arguments.
 * @param env Process environment.
 * @param platform Target operating system.
 * @returns Promise resolving to captured output and success status.
*/
function runLocalCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        {
          timeout: 1500,
          windowsHide: true,
          shell: platform === 'win32',
          env,
        },
        (error, stdout) => {
          resolve({ ok: !error, stdout })
        },
      )
    } catch {
      resolve({ ok: false })
    }
  })
}
