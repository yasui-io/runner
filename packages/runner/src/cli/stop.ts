/**
 * `yasui-runner stop` (04 §6) — graceful drain via control.sock: sessions get
 * `session.ended (reason: "interrupted")`, outbox flushed, WS closed 1000,
 * 15 s deadline then SIGTERM.
 */

import { Command } from 'commander'
import { controlSocketPath } from '../config/paths.js'
import { controlRequest } from '../daemon/control.sock.js'
import { pidAlive, readDaemonState } from '../daemon/state.js'

export function registerStop(program: Command): void {
  program
    .command('stop')
    .description('stop the runner daemon (graceful drain)')
    .action(async () => {
      const state = readDaemonState()
      try {
        await controlRequest(controlSocketPath(), { cmd: 'stop' }, 5_000)
      } catch {
        if (state && pidAlive(state.pid)) {
          process.stdout.write(`control socket unreachable — sending SIGTERM to pid ${state.pid}\n`)
          try {
            process.kill(state.pid, 'SIGTERM')
          } catch {
            /* already gone */
          }
        } else {
          process.stdout.write('yasui-runner is not running\n')
          return
        }
      }

      // Wait for the daemon to exit (drain deadline is 15 s + margin).
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        const current = readDaemonState()
        if (!current || !pidAlive(current.pid)) {
          process.stdout.write('stopped\n')
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      const current = readDaemonState()
      if (current && pidAlive(current.pid)) {
        process.stdout.write(`daemon still draining after 20 s — sending SIGTERM to pid ${current.pid}\n`)
        try {
          process.kill(current.pid, 'SIGTERM')
        } catch {
          /* gone */
        }
      } else {
        process.stdout.write('stopped\n')
      }
    })
}
