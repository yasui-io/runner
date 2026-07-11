/**
 * `yasui-runner conform --scenario <name> --code <pairing-code>` (07 §12).
 *
 * Runs the fake runner: pairs with the REAL control plane via
 * POST /relay/v1/pair, speaks real relay/v1, no Claude, no inference.
 * Long-lived — this is the e2e backend for web tests; stop with Ctrl-C.
 */

import { Command } from 'commander'
import { relayUrlFromApiUrl } from '../config/config.js'
import { normalizePairingCode, DEFAULT_API_URL } from './connect.js'
import { FakeRunner, pairFakeRunner, SCENARIOS, type ScenarioName } from '../conformance/fake-runner.js'

export function registerConform(program: Command): void {
  program
    .command('conform')
    .description('run the protocol-conformance fake runner (no Claude, no inference)')
    .requiredOption('--scenario <name>', `one of: ${SCENARIOS.join(' | ')}`)
    .option('--code <code>', 'pairing code (mint one in the dashboard)')
    .option('--token <token>', 'existing yr_ runner token (skips pairing)')
    .option('--api <url>', 'Yasui API base URL', DEFAULT_API_URL)
    .option('--relay <url>', 'relay WS URL (default: derived from --api)')
    .option('--name <name>', 'runner display name', 'conform')
    .action(async (opts: { scenario: string; code?: string; token?: string; api: string; relay?: string; name: string }) => {
      if (!SCENARIOS.includes(opts.scenario as ScenarioName)) {
        process.stderr.write(`unknown scenario ${opts.scenario} — expected ${SCENARIOS.join(' | ')}\n`)
        process.exitCode = 1
        return
      }

      let token = opts.token
      if (!token) {
        if (!opts.code) {
          process.stderr.write('either --code or --token is required\n')
          process.exitCode = 1
          return
        }
        const code = normalizePairingCode(opts.code)
        if (!code) {
          process.stderr.write('invalid pairing code — expected 8 characters like K7PF-3QWD\n')
          process.exitCode = 1
          return
        }
        try {
          const paired = await pairFakeRunner(opts.api, code, opts.name)
          token = paired.token
          process.stdout.write(`paired as runner ${paired.runnerId}\n`)
        } catch (err) {
          process.stderr.write(`${(err as Error).message}\n`)
          process.exitCode = 1
          return
        }
      }

      const relayUrl = opts.relay ?? relayUrlFromApiUrl(opts.api)
      const runner = new FakeRunner({
        relayUrl,
        token,
        scenario: opts.scenario as ScenarioName,
        name: opts.name,
        log: (message) => process.stdout.write(`[conform] ${message}\n`),
      })
      process.stdout.write(`connecting to ${relayUrl} (scenario: ${opts.scenario}) — Ctrl-C to stop\n`)
      runner.start()

      const stop = () => {
        process.stdout.write('\nstopping fake runner\n')
        runner.stop()
        process.exit(0)
      }
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)

      // Keep the process alive.
      await new Promise(() => {
        /* runs until signal */
      })
    })
}
