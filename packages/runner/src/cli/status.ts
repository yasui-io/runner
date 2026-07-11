/**
 * `yasui-runner status [--json]` (04 §6) — connection state, runner id,
 * active sessions, outbox depth, version, update availability via control.sock.
 */

import { Command } from 'commander'
import { controlSocketPath } from '../config/paths.js'
import { controlRequest, type DaemonStatus } from '../daemon/control.sock.js'

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('show daemon status')
    .option('--json', 'machine-readable output', false)
    .action(async (opts: { json: boolean }) => {
      let status: DaemonStatus
      try {
        status = await controlRequest<DaemonStatus>(controlSocketPath(), { cmd: 'status' }, 5_000)
      } catch {
        if (opts.json) process.stdout.write(JSON.stringify({ running: false }) + '\n')
        else process.stdout.write('not running\n')
        process.exitCode = 1
        return
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify(status, null, 2) + '\n')
        return
      }
      const lines = [
        `runner     ${status.runnerId}`,
        `version    ${status.version}${status.updateAvailable ? `  (update available: ${status.updateAvailable})` : ''}`,
        `pid        ${status.pid}  (started ${status.startedAt})`,
        `relay      ${status.connected ? 'connected' : 'disconnected'}  ${status.relayUrl}${status.draining ? '  [draining]' : ''}`,
        `outbox     ${status.outboxDepth} unacked frame(s)`,
        `sessions   ${status.sessions.length === 0 ? 'none' : ''}`,
        ...status.sessions.map((s) => `  - ${s.sessionId}  ${s.project}  ${s.status}`),
      ]
      process.stdout.write(lines.join('\n') + '\n')
    })
}
