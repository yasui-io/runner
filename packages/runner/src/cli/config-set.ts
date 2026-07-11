/**
 * `yasui-runner config set <allow-bypass|redaction|remote-claude-settings> <on|off>`
 * (04 §6, 08 §3/§4).
 *
 * These flags are settable ONLY here — never from the web. When the daemon is
 * connected the change is pushed as a `runner.config` frame so the control
 * plane persists it on the Runner row.
 */

import { Command } from 'commander'
import { loadConfig, saveConfig } from '../config/config.js'
import { controlSocketPath } from '../config/paths.js'
import { controlRequest, daemonReachable } from '../daemon/control.sock.js'

export function registerConfigSet(program: Command): void {
  const config = program.command('config').description('runner-local policy configuration')

  config
    .command('set <key> <value>')
    .description('set a policy flag: allow-bypass, redaction, or remote-claude-settings')
    .action(async (key: string, value: string) => {
      if (!['allow-bypass', 'redaction', 'remote-claude-settings'].includes(key)) {
        process.stderr.write(`unknown key ${key} — expected allow-bypass | redaction | remote-claude-settings\n`)
        process.exitCode = 1
        return
      }
      if (!['on', 'off'].includes(value)) {
        process.stderr.write(`invalid value ${value} — expected on | off\n`)
        process.exitCode = 1
        return
      }
      const enabled = value === 'on'
      const cfg = loadConfig()
      if (key === 'allow-bypass') {
        cfg.allowBypassPermissions = enabled
        if (enabled) {
          process.stdout.write(
            'WARNING: allow-bypass lets sessions run with bypassPermissions — the agent executes tools\n' +
              'on this machine without asking. Enable only on machines you can afford to lose.\n',
          )
        }
      } else if (key === 'redaction') {
        cfg.redactionEnabled = enabled
        if (!enabled) {
          process.stdout.write(
            'WARNING: redaction off — tool output and diffs are sent to Yasui without the secret-\n' +
              'redaction pass. The runner will be badged "redaction off" in the dashboard.\n',
          )
        }
      } else {
        cfg.remoteClaudeSettingsEnabled = enabled
        if (enabled) {
          process.stdout.write(
            'WARNING: remote-claude-settings lets your authenticated Yasui dashboard read and change\n' +
              '~/.claude/settings.json on this machine. Those settings can contain secrets and commands.\n' +
              'Keep it off unless you need the editor, and turn it off again when you are done.\n',
          )
        }
      }
      saveConfig(cfg)
      process.stdout.write(`${key} = ${value}\n`)

      const sock = controlSocketPath()
      if (await daemonReachable(sock)) {
        try {
          await controlRequest(sock, { cmd: 'reload-config' }, 10_000)
          process.stdout.write('pushed runner.config to the control plane\n')
        } catch (err) {
          process.stderr.write(`warning: could not nudge the daemon (${(err as Error).message}) — the flag applies on next connect\n`)
        }
      }
    })
}
