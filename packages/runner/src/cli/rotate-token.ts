/**
 * `yasui-runner rotate-token` (04 §6, 03 §3) — POST /relay/v1/rotate authed by
 * the current yr_ token; write the new token 0600 temp-file + rename; the
 * daemon reconnects (its old-token WS is closed 4001 by the server).
 */

import { Command } from 'commander'
import { loadConfig, saveConfig } from '../config/config.js'
import { controlSocketPath } from '../config/paths.js'
import { controlRequest, daemonReachable } from '../daemon/control.sock.js'

export function registerRotateToken(program: Command): void {
  program
    .command('rotate-token')
    .description('rotate the runner token (invalidates the old one)')
    .action(async () => {
      const config = loadConfig()
      let res: Response
      try {
        res = await fetch(`${config.apiUrl.replace(/\/+$/, '')}/relay/v1/rotate`, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.token}` },
          signal: AbortSignal.timeout(30_000),
        })
      } catch (err) {
        process.stderr.write(`could not reach ${config.apiUrl}: ${(err as Error).message}\n`)
        process.exitCode = 1
        return
      }
      if (res.status === 401) {
        process.stderr.write('current token rejected — this runner was revoked; re-pair with `yasui-runner connect`\n')
        process.exitCode = 1
        return
      }
      if (!res.ok) {
        process.stderr.write(`rotate failed with HTTP ${res.status}\n`)
        process.exitCode = 1
        return
      }
      const body = (await res.json()) as { token?: string }
      if (!body.token) {
        process.stderr.write('rotate response missing token\n')
        process.exitCode = 1
        return
      }
      config.token = body.token
      saveConfig(config)
      process.stdout.write('token rotated and written to config.json (0600)\n')

      const sock = controlSocketPath()
      if (await daemonReachable(sock)) {
        try {
          await controlRequest(sock, { cmd: 'reload-config' }, 10_000)
          process.stdout.write('daemon reconnecting with the new token\n')
        } catch {
          process.stderr.write('warning: daemon nudge failed — it will pick up the token on its next reconnect\n')
        }
      }
    })
}
