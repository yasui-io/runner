/**
 * `yasui-runner doctor` (04 §6) — each check ✔/✘ with a fix hint:
 * node >= 20, git >= 2.30, config present + 0600, token shape, HTTPS
 * reachability of apiUrl, WS reachability (dial relayUrl, expect HTTP 401
 * without auth), disk free >= 1 GiB, Claude CLI resolvable from the SDK
 * package, service unit installed/loaded, clock skew < 30 s vs the API's
 * Date header.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Command } from 'commander'
import { loadConfig, type RunnerConfig } from '../config/config.js'
import { configPath, runnerHome } from '../config/paths.js'
import { claudeSdkVersion } from '../version.js'

const require = createRequire(import.meta.url)

interface CheckResult {
  name: string
  ok: boolean
  detail: string
  hint?: string
}

function exec(cmd: string, args: string[], timeoutMs = 10_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stdout: stdout.toString(), stderr: stderr.toString() })
    })
  })
}

function parseVersion(text: string): number[] {
  const m = text.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : [0, 0, 0]
}

function versionGte(actual: number[], wanted: number[]): boolean {
  for (let i = 0; i < wanted.length; i++) {
    const a = actual[i] ?? 0
    const w = wanted[i] ?? 0
    if (a > w) return true
    if (a < w) return false
  }
  return true
}

async function checkWsReachable(relayUrl: string): Promise<CheckResult> {
  // HTTP GET against the relay path expects 401 without auth (08 §7 R1 —
  // same signal as a WS dial, and portable across Node and Bun).
  const httpUrl = relayUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:')
  try {
    const res = await fetch(httpUrl, { method: 'GET', signal: AbortSignal.timeout(8_000) })
    if (res.status === 401) {
      return { name: 'relay reachable', ok: true, detail: `${relayUrl} answers 401 without auth (reachable)` }
    }
    if (res.ok || res.status === 426) {
      // 426 Upgrade Required / 2xx — endpoint exists and answers.
      return { name: 'relay reachable', ok: true, detail: `${relayUrl} answered HTTP ${res.status}` }
    }
    return {
      name: 'relay reachable',
      ok: false,
      detail: `${relayUrl} answered HTTP ${res.status}`,
      hint: 'expected 401 — is a proxy intercepting WebSocket upgrades?',
    }
  } catch (err) {
    return {
      name: 'relay reachable',
      ok: false,
      detail: `dial failed: ${(err as Error).message}`,
      hint: 'check network/DNS and firewall/egress for wss (port 443)',
    }
  }
}

export async function runDoctor(): Promise<CheckResult[]> {
  const checks: CheckResult[] = []

  // node >= 20
  const nodeMajor = Number(process.versions.node.split('.')[0])
  checks.push({
    name: 'node >= 20',
    ok: nodeMajor >= 20,
    detail: `node ${process.versions.node}`,
    hint: nodeMajor >= 20 ? undefined : 're-run the installer: curl -fsSL https://yasui.io/runner.sh | sh (it pins Node 22 LTS)',
  })

  // git >= 2.30
  const gitRes = await exec('git', ['--version'])
  const gitVersion = parseVersion(gitRes.stdout)
  checks.push({
    name: 'git >= 2.30',
    ok: gitRes.code === 0 && versionGte(gitVersion, [2, 30]),
    detail: gitRes.code === 0 ? gitRes.stdout.trim() : 'git not found',
    hint: gitRes.code === 0 ? undefined : 'install git (macOS: xcode-select --install; Debian/Ubuntu: apt install git)',
  })

  // config present + 0600 + token shape
  let config: RunnerConfig | null = null
  try {
    config = loadConfig()
    checks.push({ name: 'config present + 0600', ok: true, detail: configPath() })
  } catch (err) {
    checks.push({
      name: 'config present + 0600',
      ok: false,
      detail: (err as Error).message,
      hint: 'pair with `yasui-runner connect --code XXXX-XXXX`, or chmod 600 the config file',
    })
  }
  checks.push({
    name: 'token shape',
    ok: config !== null && /^yr_[A-Za-z0-9_-]{10,}$/.test(config.token),
    detail: config ? `${config.token.slice(0, 8)}…` : 'no config',
    hint: config ? undefined : 're-pair with `yasui-runner connect`',
  })

  // HTTPS reachability + clock skew (Date header)
  if (config) {
    try {
      const res = await fetch(config.apiUrl, { method: 'GET', signal: AbortSignal.timeout(10_000) })
      checks.push({ name: 'api reachable', ok: true, detail: `${config.apiUrl} → HTTP ${res.status}` })
      const dateHeader = res.headers.get('date')
      if (dateHeader) {
        const skewMs = Math.abs(Date.now() - Date.parse(dateHeader))
        checks.push({
          name: 'clock skew < 30 s',
          ok: skewMs < 30_000,
          detail: `${Math.round(skewMs / 1000)} s vs ${config.apiUrl}`,
          hint: skewMs < 30_000 ? undefined : 'enable NTP (macOS: Date & Time settings; Linux: timedatectl set-ntp true)',
        })
      } else {
        checks.push({ name: 'clock skew < 30 s', ok: true, detail: 'API sent no Date header — skipped' })
      }
    } catch (err) {
      checks.push({
        name: 'api reachable',
        ok: false,
        detail: `${config.apiUrl}: ${(err as Error).message}`,
        hint: 'check network/DNS; the runner needs outbound HTTPS to the API',
      })
      checks.push({ name: 'clock skew < 30 s', ok: false, detail: 'API unreachable — cannot measure', hint: 'fix API reachability first' })
    }
    checks.push(await checkWsReachable(config.relayUrl))
  } else {
    checks.push({ name: 'api reachable', ok: false, detail: 'no config', hint: 'pair first' })
    checks.push({ name: 'relay reachable', ok: false, detail: 'no config', hint: 'pair first' })
    checks.push({ name: 'clock skew < 30 s', ok: false, detail: 'no config', hint: 'pair first' })
  }

  // disk free >= 1 GiB
  try {
    const stat = fs.statfsSync(fs.existsSync(runnerHome()) ? runnerHome() : os.homedir())
    const freeBytes = stat.bavail * stat.bsize
    checks.push({
      name: 'disk free >= 1 GiB',
      ok: freeBytes >= 1024 ** 3,
      detail: `${(freeBytes / 1024 ** 3).toFixed(1)} GiB free`,
      hint: freeBytes >= 1024 ** 3 ? undefined : 'free disk space — outbox spillover and logs need room',
    })
  } catch {
    checks.push({ name: 'disk free >= 1 GiB', ok: true, detail: 'statfs unavailable — skipped' })
  }

  // Claude CLI resolvable from the SDK package (the native CLI ships in the
  // platform-specific optional dependency as a `claude` binary — 04 §3).
  const sdkVersion = claudeSdkVersion()
  if (sdkVersion) {
    let cliFound = false
    let cliDetail = `@anthropic-ai/claude-agent-sdk ${sdkVersion}`
    const platformPkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
    // Resolve the platform package FROM the SDK's own location (it is the
    // SDK's optional dependency, not ours).
    let sdkDir: string | null = null
    try {
      sdkDir = path.dirname(fs.realpathSync(require.resolve('@anthropic-ai/claude-agent-sdk/package.json')))
    } catch {
      try {
        sdkDir = path.dirname(fs.realpathSync(require.resolve('@anthropic-ai/claude-agent-sdk')))
      } catch {
        sdkDir = null
      }
    }
    if (sdkDir) {
      try {
        const sdkRequire = createRequire(path.join(sdkDir, 'noop.js'))
        const platformPkgJson = sdkRequire.resolve(`${platformPkg}/package.json`)
        const claudeBin = path.join(path.dirname(fs.realpathSync(platformPkgJson)), 'claude')
        if (fs.existsSync(claudeBin)) {
          cliFound = true
          cliDetail += ` (cli: ${claudeBin})`
        } else {
          cliDetail += ` (${platformPkg} present but no claude binary)`
        }
      } catch {
        // Fall back: binary next to the SDK package itself (bundled layouts).
        const candidates = ['claude', 'cli.js', 'cli.mjs', path.join('dist', 'cli.js')]
        const hit = candidates.find((c) => fs.existsSync(path.join(sdkDir as string, c)))
        if (hit) {
          cliFound = true
          cliDetail += ` (cli: ${path.join(sdkDir, hit)})`
        } else {
          cliDetail += ` (${platformPkg} not installed)`
        }
      }
    } else {
      cliDetail += ' (SDK package dir not resolvable)'
    }
    checks.push({
      name: 'claude cli resolvable',
      ok: cliFound,
      detail: cliDetail,
      hint: cliFound ? undefined : 'reinstall: curl -fsSL https://yasui.io/runner.sh | sh',
    })
  } else {
    checks.push({
      name: 'claude cli resolvable',
      ok: false,
      detail: '@anthropic-ai/claude-agent-sdk not installed',
      hint: 'reinstall: curl -fsSL https://yasui.io/runner.sh | sh',
    })
  }

  // service unit installed/loaded
  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'io.yasui.runner.plist')
    if (!fs.existsSync(plist)) {
      checks.push({ name: 'service unit', ok: false, detail: 'launchd agent not installed', hint: 'run `yasui-runner install-service`' })
    } else {
      const loaded = await exec('launchctl', ['print', `gui/${process.getuid?.() ?? 501}/io.yasui.runner`])
      checks.push({
        name: 'service unit',
        ok: loaded.code === 0,
        detail: loaded.code === 0 ? 'launchd agent loaded' : 'plist present but not loaded',
        hint: loaded.code === 0 ? undefined : 'run `yasui-runner install-service` again to bootstrap it',
      })
    }
  } else if (process.platform === 'linux') {
    const enabled = await exec('systemctl', ['--user', 'is-enabled', 'yasui-runner'])
    checks.push({
      name: 'service unit',
      ok: enabled.code === 0,
      detail: enabled.code === 0 ? 'systemd user unit enabled' : 'systemd user unit not enabled',
      hint: enabled.code === 0 ? undefined : 'run `yasui-runner install-service` (and `loginctl enable-linger $USER` on headless hosts)',
    })
  } else {
    checks.push({ name: 'service unit', ok: false, detail: `unsupported platform ${process.platform}`, hint: 'v1 supports macOS and Linux' })
  }

  return checks
}

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('diagnose this runner installation')
    .action(async () => {
      const checks = await runDoctor()
      let failures = 0
      for (const check of checks) {
        const mark = check.ok ? '✔' : '✘'
        process.stdout.write(`${mark} ${check.name.padEnd(24)} ${check.detail}\n`)
        if (!check.ok) {
          failures++
          if (check.hint) process.stdout.write(`    fix: ${check.hint}\n`)
        }
      }
      if (failures > 0) {
        process.stdout.write(`\n${failures} check(s) failed\n`)
        process.exitCode = 1
      } else {
        process.stdout.write('\nall checks passed\n')
      }
    })
}
