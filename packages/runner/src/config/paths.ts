/**
 * ~/.yasui-runner directory layout (04 §5). Root override: YASUI_RUNNER_HOME.
 *
 * All helpers re-read the env var per call so tests (and the daemon after a
 * re-exec) always see the current override.
 */

import os from 'node:os'
import path from 'node:path'

export function runnerHome(): string {
  const override = process.env.YASUI_RUNNER_HOME
  if (override && override.length > 0) return path.resolve(override)
  return path.join(os.homedir(), '.yasui-runner')
}

export const configPath = () => path.join(runnerHome(), 'config.json')
export const binDir = () => path.join(runnerHome(), 'bin')
export const shimPath = () => path.join(binDir(), 'yasui-runner')
export const runtimeDir = () => path.join(runnerHome(), 'runtime')
export const toolDir = () => path.join(runnerHome(), 'tool')
export const toolStagingDir = () => path.join(runnerHome(), 'tool.staging')
export const toolPrevDir = () => path.join(runnerHome(), 'tool.prev')

export const logsDir = () => path.join(runnerHome(), 'logs')
export const runnerLogPath = () => path.join(logsDir(), 'runner.log')
export const sessionLogsDir = () => path.join(logsDir(), 'sessions')
export const sessionLogPath = (sessionId: string) => path.join(sessionLogsDir(), `${safeName(sessionId)}.log`)

export const outboxDir = () => path.join(runnerHome(), 'outbox')
export const outboxPath = (sessionId: string) => path.join(outboxDir(), `${safeName(sessionId)}.jsonl`)

export const stateDir = () => path.join(runnerHome(), 'state')
export const daemonStatePath = () => path.join(stateDir(), 'daemon.json')
export const controlSocketPath = () => path.join(stateDir(), 'control.sock')
export const projectsCachePath = () => path.join(stateDir(), 'projects.json')
export const updateMarkerPath = () => path.join(stateDir(), 'update.json')

/** CLAUDE_CONFIG_DIR for all harness sessions (05-claude-adapter.md). */
export const claudeConfigDir = () => path.join(runnerHome(), 'claude')

/** Session ids come from the wire — never let them traverse the filesystem. */
function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_')
}
