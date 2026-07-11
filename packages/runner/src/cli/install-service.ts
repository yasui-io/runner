/**
 * `yasui-runner install-service [--uninstall]` (04 §7).
 *
 * Generates user-level service units from the templates in install/
 * (embedded verbatim below — install/*.tmpl are the canonical repo copies),
 * substituting the shim path and log paths. Always runs the daemon as the
 * login user, never root.
 *
 * Exit-code contract: exit 0 = intentional stop (do not restart);
 * nonzero = crash (restart). Encoded as KeepAlive.SuccessfulExit=false /
 * Restart=on-failure.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Command } from 'commander'

/** Keep in sync with install/io.yasui.runner.plist.tmpl (04 §7 verbatim). */
export const LAUNCHD_PLIST_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>io.yasui.runner</string>
  <key>ProgramArguments</key>
  <array><string>{{HOME}}/.yasui-runner/bin/yasui-runner</string>
         <string>start</string><string>--foreground</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>{{HOME}}/.yasui-runner/logs/runner.log</string>
  <key>StandardErrorPath</key><string>{{HOME}}/.yasui-runner/logs/runner.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key>
    <string>{{HOME}}/.yasui-runner/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
</dict></plist>
`

/** Keep in sync with install/yasui-runner.service.tmpl (04 §7 verbatim). */
export const SYSTEMD_UNIT_TEMPLATE = `[Unit]
Description=Yasui runner — https://github.com/yasui-io/runner
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%h/.yasui-runner/bin/yasui-runner start --foreground
Restart=on-failure
RestartSec=5
Environment=YASUI_RUNNER_HOME=%h/.yasui-runner

[Install]
WantedBy=default.target
`

function exec(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stdout: stdout.toString(), stderr: stderr.toString() })
    })
  })
}

async function installDarwin(): Promise<void> {
  const home = os.homedir()
  const plistDir = path.join(home, 'Library', 'LaunchAgents')
  const plistPath = path.join(plistDir, 'io.yasui.runner.plist')
  fs.mkdirSync(plistDir, { recursive: true })
  fs.mkdirSync(path.join(home, '.yasui-runner', 'logs'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(plistPath, LAUNCHD_PLIST_TEMPLATE.replaceAll('{{HOME}}', home))
  const uid = process.getuid?.() ?? 501
  // Re-bootstrap idempotently.
  await exec('launchctl', ['bootout', `gui/${uid}/io.yasui.runner`])
  const bootstrap = await exec('launchctl', ['bootstrap', `gui/${uid}`, plistPath])
  if (bootstrap.code !== 0) {
    throw new Error(`launchctl bootstrap failed: ${bootstrap.stderr.trim() || bootstrap.stdout.trim()}`)
  }
  await exec('launchctl', ['enable', `gui/${uid}/io.yasui.runner`])
  process.stdout.write(`installed + loaded launchd agent ${plistPath}\n`)
}

async function uninstallDarwin(): Promise<void> {
  const uid = process.getuid?.() ?? 501
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'io.yasui.runner.plist')
  await exec('launchctl', ['bootout', `gui/${uid}/io.yasui.runner`])
  try {
    fs.unlinkSync(plistPath)
  } catch {
    /* not installed */
  }
  process.stdout.write('launchd agent removed\n')
}

async function installLinux(): Promise<void> {
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user')
  const unitPath = path.join(unitDir, 'yasui-runner.service')
  fs.mkdirSync(unitDir, { recursive: true })
  fs.writeFileSync(unitPath, SYSTEMD_UNIT_TEMPLATE)
  const reload = await exec('systemctl', ['--user', 'daemon-reload'])
  if (reload.code !== 0) throw new Error(`systemctl --user daemon-reload failed: ${reload.stderr.trim()}`)
  const enable = await exec('systemctl', ['--user', 'enable', '--now', 'yasui-runner'])
  if (enable.code !== 0) throw new Error(`systemctl --user enable --now failed: ${enable.stderr.trim()}`)
  process.stdout.write(
    `installed + started systemd user unit ${unitPath}\n\n` +
      `on headless VPSes, run this once so the unit survives logout:\n  loginctl enable-linger ${os.userInfo().username}\n`,
  )
}

async function uninstallLinux(): Promise<void> {
  await exec('systemctl', ['--user', 'disable', '--now', 'yasui-runner'])
  try {
    fs.unlinkSync(path.join(os.homedir(), '.config', 'systemd', 'user', 'yasui-runner.service'))
  } catch {
    /* not installed */
  }
  await exec('systemctl', ['--user', 'daemon-reload'])
  process.stdout.write('systemd user unit removed\n')
}

export function registerInstallService(program: Command): void {
  program
    .command('install-service')
    .description('install a user-level launchd/systemd unit that keeps the runner alive')
    .option('--uninstall', 'remove the service unit', false)
    .action(async (opts: { uninstall: boolean }) => {
      try {
        if (process.platform === 'darwin') {
          if (opts.uninstall) await uninstallDarwin()
          else await installDarwin()
        } else if (process.platform === 'linux') {
          if (opts.uninstall) await uninstallLinux()
          else await installLinux()
        } else {
          process.stderr.write(`unsupported platform ${process.platform} — v1 supports macOS and Linux\n`)
          process.exitCode = 1
        }
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`)
        process.exitCode = 1
      }
    })
}
