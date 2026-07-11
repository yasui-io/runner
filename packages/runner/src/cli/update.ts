/**
 * `yasui-runner update [--to <version>]` (04 §12).
 *
 * When the daemon is running, hands the drain-and-update to it (control
 * socket `drain`); otherwise stages/verifies/swaps directly. Degrades with a
 * clear message when not installed via runner.sh.
 */

import { Command } from 'commander'
import { loadConfig } from '../config/config.js'
import { controlSocketPath } from '../config/paths.js'
import { controlRequest, daemonReachable } from '../daemon/control.sock.js'
import { checkLatestVersion, isManagedInstall, NOT_INSTALLED_MESSAGE, performUpdate } from '../update/self-update.js'
import { RUNNER_VERSION } from '../version.js'

export function registerUpdate(program: Command): void {
  program
    .command('update')
    .description('update @yasui.io/runner (verified with npm provenance signatures)')
    .option('--to <version>', 'target version (default: the configured channel\'s latest)')
    .action(async (opts: { to?: string }) => {
      if (!isManagedInstall()) {
        process.stderr.write(`${NOT_INSTALLED_MESSAGE}\n`)
        process.exitCode = 1
        return
      }
      let channel = 'latest'
      try {
        channel = loadConfig({ insecurePerms: true }).update.channel
      } catch {
        /* not paired yet — updating is still fine */
      }
      const target = opts.to ?? (await checkLatestVersion(channel))
      if (!target) {
        process.stderr.write('could not determine the latest version from the npm registry\n')
        process.exitCode = 1
        return
      }
      if (target === RUNNER_VERSION) {
        process.stdout.write(`already on ${RUNNER_VERSION}\n`)
        return
      }

      const sock = controlSocketPath()
      if (await daemonReachable(sock)) {
        try {
          await controlRequest(sock, { cmd: 'drain', targetVersion: target }, 10_000)
          process.stdout.write(
            `daemon is draining for the update to ${target} — it stages, verifies signatures, swaps and restarts itself.\n` +
              'follow along with `yasui-runner status` / the runner log.\n',
          )
          return
        } catch (err) {
          process.stderr.write(`daemon drain request failed (${(err as Error).message}) — updating directly\n`)
        }
      }

      const result = await performUpdate(target, {
        info: (m) => process.stdout.write(`${m}\n`),
        warn: (m) => process.stderr.write(`${m}\n`),
      })
      if (!result.ok) {
        process.stderr.write(`update failed (${result.reason}): ${result.message}\n`)
        process.exitCode = 1
        return
      }
      process.stdout.write(`updated ${result.from} → ${result.to}; restart the daemon with \`yasui-runner start\`\n`)
    })
}
