/**
 * Domain types describing the AI coding agents CodePulse monitors and the
 * project directories they work in.
 *
 * @module shared/types/agent
 */

/**
 * Discriminator for the kinds of AI coding agents CodePulse can monitor.
 *
 * Used throughout the codebase as the `source` of an event and the key that
 * identifies a runtime state slot.
 */
export type AgentType = 'codex' | 'claude_code'

/**
 * A monitored AI coding agent and what CodePulse knows about its installation.
 *
 * This is the persistent description of an agent (is it installed? are its
 * hooks configured?), as opposed to {@link AgentRuntimeState}, which is the
 * live activity of a running session.
 */
export interface Agent {
  /** Stable internal identifier. */
  id: string
  /** Which agent this is. */
  type: AgentType
  /** Human-readable display name, e.g. `"Claude Code"`. */
  name: string
  /** Whether the agent's CLI was detected on this machine. */
  installed: boolean
  /** Whether CodePulse's hooks are wired into the agent. */
  configured: boolean
  /** Detected CLI version string, when known. */
  version?: string
  /** Epoch millis of the last event received from this agent. */
  lastSeenAt?: number
}

/**
 * A project directory (workspace) an agent is operating in.
 *
 * Workspaces are derived from the `cwd` / workspace path carried on incoming
 * events and are used to group sessions and label the Dashboard.
 */
export interface Workspace {
  /** Stable internal identifier. */
  id: string
  /** Display name, typically the final path segment. */
  name: string
  /** Absolute path to the project directory. */
  path: string
  /** Current git branch, when reported by the status line. */
  gitBranch?: string
  /** Epoch millis the workspace was last active. */
  lastActiveAt: number
}
