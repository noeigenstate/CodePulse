/**
 * 本地 agent 安装/配置检测。这些探测是尽力而为的，只读取本地
 * 配置/CLI 元数据，绝不修改 agent 设置。
 *
 * @module local-server/agent-detect
 */
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

/** 检测 CodePulse 当前知道如何探测的所有 agent。 */
export async function detectAgents(options: AgentDetectOptions = {}): Promise<Agent[]> {
  return [
    await detectClaudeAgent(options),
    await detectCodexAgent(options),
    await detectGrokAgent(options),
  ]
}

/**
 * 检测 Codex CLI 是否存在，以及 Codex 配置文件中是否出现
 * CodePulse 的 hook。
 */
export async function detectCodexAgent(options: AgentDetectOptions = {}): Promise<Agent> {
  const env = options.env ?? process.env
  const runCommand = options.runCommand ?? runLocalCommand
  const configPath = codexConfigPath(options)
  const hooksPath = codexHooksPath(options)

  const versionResult = await runFirstAvailableCommand(
    env['CODEX_CLI_PATH'] ? [env['CODEX_CLI_PATH']] : commandCandidates('codex', options),
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

/** 检测 Claude Code CLI 及 CodePulse 的 hook/status-line 配置。 */
export async function detectClaudeAgent(options: AgentDetectOptions = {}): Promise<Agent> {
  const env = options.env ?? process.env
  const runCommand = options.runCommand ?? runLocalCommand
  const configPath = claudeConfigPath(options)

  const versionResult = await runFirstAvailableCommand(
    env['CLAUDE_CLI_PATH'] ? [env['CLAUDE_CLI_PATH']] : commandCandidates('claude', options),
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

/** 检测 Grok Build CLI 及 CodePulse 的全局 hook 配置。 */
export async function detectGrokAgent(options: AgentDetectOptions = {}): Promise<Agent> {
  const env = options.env ?? process.env
  const runCommand = options.runCommand ?? runLocalCommand
  const hooksPath = grokHooksPath(options)

  const versionResult = await runFirstAvailableCommand(
    env['GROK_CLI_PATH'] ? [env['GROK_CLI_PATH']] : commandCandidates('grok', options),
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

/** 解析 Codex 配置文件路径（环境变量可覆盖，默认 `~/.codex/config.toml`）。 */
function codexConfigPath(options: AgentDetectOptions): string {
  const env = options.env ?? process.env
  return (
    env['CODEPULSE_CODEX_CONFIG_FILE'] ??
    join(options.homeDir ?? homedir(), '.codex', 'config.toml')
  )
}

function codexHooksPath(options: AgentDetectOptions): string {
  const env = options.env ?? process.env
  return (
    env['CODEPULSE_CODEX_HOOKS_FILE'] ?? join(options.homeDir ?? homedir(), '.codex', 'hooks.json')
  )
}

/** 解析 Claude 配置文件路径（环境变量可覆盖，默认 `~/.claude/settings.json`）。 */
function claudeConfigPath(options: AgentDetectOptions): string {
  const env = options.env ?? process.env
  return (
    env['CODEPULSE_CLAUDE_CONFIG_FILE'] ??
    join(options.homeDir ?? homedir(), '.claude', 'settings.json')
  )
}

/** 解析 Grok CodePulse hook 文件路径（默认 `~/.grok/hooks/codepulse.json`）。 */
function grokHooksPath(options: AgentDetectOptions): string {
  const env = options.env ?? process.env
  return (
    env['CODEPULSE_GROK_HOOKS_FILE'] ??
    join(options.homeDir ?? homedir(), '.grok', 'hooks', 'codepulse.json')
  )
}

/** 判断文件是否包含任一关键字（不区分大小写）；文件不存在时返回 false。 */
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

/** 取版本输出的首行作为版本字符串。 */
function cleanVersion(stdout: string | undefined): string | undefined {
  const text = stdout?.trim()
  return text ? text.split(/\r?\n/)[0] : undefined
}

function commandCandidates(command: string, options: AgentDetectOptions): string[] {
  return (options.platform ?? process.platform) === 'win32'
    ? [`${command}.cmd`, command, `${command}.exe`]
    : [command]
}

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

/** 以 1.5 秒超时执行本地命令；从不抛出，失败时 `ok: false`。 */
function runLocalCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { timeout: 1500, windowsHide: true, shell: process.platform === 'win32' },
        (error, stdout) => {
          resolve({ ok: !error, stdout })
        },
      )
    } catch {
      resolve({ ok: false })
    }
  })
}
