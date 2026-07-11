/**
 * `yasui-runner start [--foreground]` (04 §6).
 *
 * Default: detached child (stdio → logs via pino file destination), writes
 * `state/daemon.json`, opens `state/control.sock`. `--foreground` for service
 * managers (04 §7). Refuses to start twice (live pid + socket check).
 */

import { spawn } from 'node:child_process'
import { Command } from 'commander'
import { controlSocketPath } from '../config/paths.js'
import { daemonReachable } from '../daemon/control.sock.js'
import { isDaemonRunning } from '../daemon/state.js'

const DAEMONIZED_ENV = 'YASUI_RUNNER_DAEMONIZED'

export function registerStart(program: Command): void {
  program
    .command('start')
    .description('start the runner daemon')
    .option('--foreground', 'run in the foreground (for launchd/systemd)', false)
    .option('--insecure-perms', 'allow group/world-readable config.json (NOT recommended)', false)
    .action(async (opts: { foreground: boolean; insecurePerms: boolean }) => {
      if (await isDaemonRunning()) {
        process.stderr.write('yasui-runner is already running (see `yasui-runner status`)\n')
        process.exitCode = 1
        return
      }

      if (opts.foreground) {
        // Service-manager mode: log to stderr (captured by launchd/systemd) unless
        // this is the detached child spawned below, which logs to the file itself.
        // Lazy import: the daemon graph (adapters, SDK) loads only when starting.
        const { runDaemon } = await import('../daemon/daemon.js')
        await runDaemon({
          logToFile: process.env[DAEMONIZED_ENV] === '1',
          insecurePerms: opts.insecurePerms,
        })
        return
      }

      const entry = process.argv[1]
      if (!entry) {
        process.stderr.write('cannot determine CLI entrypoint for background start — use --foreground\n')
        process.exitCode = 1
        return
      }
      const args = [entry, 'start', '--foreground']
      if (opts.insecurePerms) args.push('--insecure-perms')
      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, [DAEMONIZED_ENV]: '1' },
      })
      child.unref()

      // Wait for the control socket to come up (or the child to die).
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline) {
        if (await daemonReachable(controlSocketPath())) {
          process.stdout.write(`yasui-runner daemon started (pid ${child.pid})\n`)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      process.stderr.write(
        'daemon did not come up within 8 s — check the log with `tail ~/.yasui-runner/logs/runner.log` or run `yasui-runner start --foreground`\n',
      )
      process.exitCode = 1
    })
}
