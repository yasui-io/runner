/**
 * config.json — the ONLY file containing the runner token (04 §5).
 *
 * - zod schema below is the source of truth for the file format.
 * - Load fails hard if the file mode allows group/world access (0600 required)
 *   unless the caller passes `insecurePerms: true` (`--insecure-perms`, 08 T7a).
 * - Writes go through temp-file + rename, with the temp fd opened 0600 BEFORE
 *   the token bytes are written (04 §6).
 */

import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { configPath, runnerHome } from './paths.js'

export const CONFIG_VERSION = 1

export const runnerConfigSchema = z.object({
  version: z.literal(CONFIG_VERSION),
  runnerId: z.string().min(1),
  /** Plaintext yr_ runner token — exists ONLY here. */
  token: z.string().regex(/^yr_[A-Za-z0-9_-]{10,}$/),
  relayUrl: z.string().min(1),
  apiUrl: z.string().min(1),
  /** Hostname default; shown as Device.name in the UI. */
  name: z.string().min(1).max(64),
  kind: z.enum(['laptop', 'desktop', 'vps']).default('laptop'),
  locationHint: z.string().max(120).optional(),
  /** Project discovery allowlist (04 §8.4). */
  roots: z.array(z.string()).default([]),
  /** Realpaths opted in via `projects trust` (04 §6, 08 T5b). */
  trustedProjects: z.array(z.string()).default([]),
  /** Settable ONLY via the runner CLI — never from the web (08 §3). */
  allowBypassPermissions: z.boolean().default(false),
  /** Settable ONLY via the runner CLI (08 §4). */
  redactionEnabled: z.boolean().default(true),
  /** Explicit local opt-in before the web control plane may edit ~/.claude/settings.json. */
  remoteClaudeSettingsEnabled: z.boolean().default(false),
  maxConcurrentSessions: z.number().int().positive().max(64).default(2),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  update: z
    .object({
      auto: z.boolean().default(true),
      channel: z.string().default('latest'),
    })
    .default({ auto: true, channel: 'latest' }),
})

export type RunnerConfig = z.infer<typeof runnerConfigSchema>

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly kind: 'missing' | 'perms' | 'invalid',
  ) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function configExists(): boolean {
  return fs.existsSync(configPath())
}

/**
 * Load and validate config.json. Hard-fails on group/world-readable modes
 * (0600 required) unless `insecurePerms` is set.
 */
export function loadConfig(opts: { insecurePerms?: boolean } = {}): RunnerConfig {
  const file = configPath()
  let raw: string
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    throw new ConfigError(
      `No runner config at ${file} — run \`yasui-runner connect --code XXXX-XXXX\` to pair this machine.`,
      'missing',
    )
  }
  if (!opts.insecurePerms && process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new ConfigError(
      `${file} is group/world-accessible (mode ${(stat.mode & 0o777).toString(8)}). ` +
        `It holds the runner token — fix with \`chmod 600 ${file}\`, or pass --insecure-perms to override.`,
      'perms',
    )
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${(err as Error).message}`, 'invalid')
  }
  const parsed = runnerConfigSchema.safeParse(parsedJson)
  if (!parsed.success) {
    throw new ConfigError(`${file} failed validation: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'invalid')
  }
  return parsed.data
}

/**
 * Atomic 0600 write: open temp fd with mode 0600 (before any secret bytes hit
 * disk), write, fsync, rename over config.json.
 */
export function saveConfig(config: RunnerConfig): void {
  const validated = runnerConfigSchema.parse(config)
  const home = runnerHome()
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const file = configPath()
  const tmp = path.join(home, `.config.json.tmp-${process.pid}-${Date.now()}`)
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    fs.writeSync(fd, JSON.stringify(validated, null, 2) + '\n')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

/** Derive the relay WS URL from the API base URL (04 §6 — relayUrl is never returned by pair). */
export function relayUrlFromApiUrl(apiUrl: string): string {
  const url = new URL(apiUrl)
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
  url.pathname = url.pathname.replace(/\/+$/, '') + '/relay/v1'
  url.search = ''
  url.hash = ''
  return url.toString()
}
