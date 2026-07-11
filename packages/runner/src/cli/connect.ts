/**
 * `yasui-runner connect --code XXXX-XXXX` — pairing (04 §6, contract 03 §3).
 *
 * POST {apiUrl}/relay/v1/pair; on success write config.json via temp-file +
 * rename with the fd opened 0600 BEFORE the token is written; preserve
 * existing roots when re-pairing; prompt for a first projects root.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { Command } from 'commander'
import { CONFIG_VERSION, configExists, loadConfig, relayUrlFromApiUrl, saveConfig, type RunnerConfig } from '../config/config.js'
import { configPath } from '../config/paths.js'
import { detectHarnesses, RUNNER_VERSION } from '../version.js'

export const DEFAULT_API_URL = 'https://api.yasui.io'

/** Canonical alphabet: A–Z minus I,O plus 2–9 (03 §3); compare hyphen-insensitive uppercase (08 §2). */
export const PAIRING_CODE_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/

export function normalizePairingCode(input: string): string | null {
  const stripped = input.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (stripped.length !== 8) return null
  const code = `${stripped.slice(0, 4)}-${stripped.slice(4)}`
  return PAIRING_CODE_RE.test(code) ? code : null
}

interface PairResponse {
  runnerId: string
  token: string
}

async function pair(apiUrl: string, body: Record<string, unknown>): Promise<PairResponse> {
  let res: Response
  try {
    res = await fetch(`${apiUrl.replace(/\/+$/, '')}/relay/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    throw new Error(`could not reach ${apiUrl}: ${(err as Error).message}`)
  }
  let json: { runnerId?: string; token?: string; error?: { code?: string; message?: string }; code?: string } = {}
  try {
    json = (await res.json()) as typeof json
  } catch {
    /* non-JSON error body */
  }
  if (res.ok && json.runnerId && json.token) {
    return { runnerId: json.runnerId, token: json.token }
  }
  const code = json.error?.code ?? json.code
  const message = json.error?.message
  switch (res.status) {
    case 400:
      throw new Error(`pairing code invalid (${code ?? 'yasui_pairing_code_invalid'}) — mint a new code in the dashboard`)
    case 410:
      throw new Error(`pairing code expired or already used (${code ?? 'yasui_pairing_code_expired'}) — mint a new code in the dashboard`)
    case 429:
      throw new Error(`pairing rate limited (${code ?? 'yasui_pairing_rate_limited'}) — wait a few minutes and retry`)
    default:
      throw new Error(`pairing failed with HTTP ${res.status}${message ? `: ${message}` : ''}`)
  }
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve))
  } finally {
    rl.close()
  }
}

export function registerConnect(program: Command): void {
  program
    .command('connect')
    .description('pair this machine with your Yasui account')
    .requiredOption('--code <code>', 'pairing code from the dashboard (XXXX-XXXX)')
    .option('--name <name>', 'device name shown in the dashboard', os.hostname().split('.')[0])
    .option('--kind <kind>', 'device kind: laptop | desktop | vps', 'laptop')
    .option('--api <url>', 'Yasui API base URL', DEFAULT_API_URL)
    .action(async (opts: { code: string; name: string; kind: string; api: string }) => {
      const code = normalizePairingCode(opts.code)
      if (!code) {
        process.stderr.write('invalid pairing code — expected 8 characters like K7PF-3QWD (letters A–Z without I/O, digits 2–9)\n')
        process.exitCode = 1
        return
      }
      if (!['laptop', 'desktop', 'vps'].includes(opts.kind)) {
        process.stderr.write(`invalid --kind ${opts.kind} — expected laptop | desktop | vps\n`)
        process.exitCode = 1
        return
      }

      let paired: PairResponse
      try {
        paired = await pair(opts.api, {
          code,
          name: opts.name,
          os: process.platform,
          arch: process.arch,
          kind: opts.kind,
          version: RUNNER_VERSION,
          harnesses: detectHarnesses().map((h) => ({ harness: h.harness, version: h.version })),
        })
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`)
        process.exitCode = 1
        return
      }

      // Preserve roots/trust/policy on re-pair (04 §6).
      let previous: RunnerConfig | null = null
      if (configExists()) {
        try {
          previous = loadConfig({ insecurePerms: true })
        } catch {
          previous = null
        }
      }

      const config: RunnerConfig = {
        version: CONFIG_VERSION,
        runnerId: paired.runnerId,
        token: paired.token,
        relayUrl: relayUrlFromApiUrl(opts.api),
        apiUrl: opts.api.replace(/\/+$/, ''),
        name: opts.name,
        kind: opts.kind as RunnerConfig['kind'],
        ...(previous?.locationHint ? { locationHint: previous.locationHint } : {}),
        roots: previous?.roots ?? [],
        trustedProjects: previous?.trustedProjects ?? [],
        allowBypassPermissions: previous?.allowBypassPermissions ?? false,
        redactionEnabled: previous?.redactionEnabled ?? true,
        remoteClaudeSettingsEnabled: previous?.remoteClaudeSettingsEnabled ?? false,
        maxConcurrentSessions: previous?.maxConcurrentSessions ?? 2,
        logLevel: previous?.logLevel ?? 'info',
        update: previous?.update ?? { auto: true, channel: 'latest' },
      }
      saveConfig(config)
      process.stdout.write(`paired as runner ${paired.runnerId}\nconfig written to ${configPath()} (mode 0600)\n`)

      // Prompt for a first projects root (skipped when non-interactive).
      if (config.roots.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
        const answer = (await promptLine('Add a projects root now? [~/dev] ')).trim()
        const candidate = expandHome(answer.length > 0 ? answer : '~/dev')
        try {
          const real = fs.realpathSync(candidate)
          if (fs.statSync(real).isDirectory()) {
            config.roots = [real]
            saveConfig(config)
            process.stdout.write(`added projects root ${real}\n`)
          }
        } catch {
          process.stdout.write(`skipping — ${candidate} does not exist (add later with \`yasui-runner projects add <path>\`)\n`)
        }
      } else if (config.roots.length > 0) {
        process.stdout.write(`kept existing projects roots: ${config.roots.join(', ')}\n`)
      }

      process.stdout.write('\nnext: yasui-runner start\n')
    })
}
