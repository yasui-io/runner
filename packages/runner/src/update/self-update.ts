/**
 * Self-update (04 §12).
 *
 * Signing: npm provenance attestations (Sigstore) verified with
 * `npm audit signatures` — the updater refuses any version that fails
 * registry signature + provenance verification.
 *
 * Flow: drain (caller's job) → stage `npm install --prefix tool.staging` →
 * `npm audit signatures` → smoke (`--version` + protocol fixture self-check)
 * → atomic swap (tool → tool.prev, tool.staging → tool) → restart.
 *
 * Degrades gracefully when run in-repo: the private-prefix layout
 * (~/.yasui-runner/tool/node_modules/@yasui.io/runner) doesn't exist there, so
 * every entry point reports "not installed via runner.sh" instead of failing
 * halfway.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { toolDir, toolPrevDir, toolStagingDir, updateMarkerPath, stateDir } from '../config/paths.js'
import { RUNNER_VERSION } from '../version.js'

const NPM_TIMEOUT_MS = 5 * 60 * 1000
export const UPDATE_DRAIN_DEFAULT_MS = 30 * 60 * 1000

export type UpdateResult =
  | { ok: true; from: string; to: string }
  | { ok: false; reason: 'not-installed' | 'stage-failed' | 'verify-failed' | 'smoke-failed' | 'swap-failed'; message: string }

function run(cmd: string, args: string[], timeoutMs = NPM_TIMEOUT_MS): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
      const code = error ? 1 : 0
      resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() })
    })
  })
}

/** Entry point path of an installed tool prefix. */
function installedCliEntry(prefix: string): string {
  return path.join(prefix, 'node_modules', '@yasui', 'runner', 'dist', 'cli', 'index.js')
}

/** True when running from the runner.sh private-prefix layout (04 §3). */
export function isManagedInstall(): boolean {
  return fs.existsSync(installedCliEntry(toolDir()))
}

export const NOT_INSTALLED_MESSAGE =
  'not installed via runner.sh — this runner is running from a source checkout or a manual npm install. ' +
  'Update with `git pull` / `npm install`, or install with `curl -fsSL https://yasui.io/runner.sh | sh`.'

/** Latest published version for a dist-tag from the npm registry. */
export async function checkLatestVersion(channel = 'latest'): Promise<string | null> {
  try {
    const res = await fetch('https://registry.npmjs.org/@yasui%2Frunner', {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { 'dist-tags'?: Record<string, string> }
    return body['dist-tags']?.[channel] ?? null
  } catch {
    return null
  }
}

export interface UpdateHooks {
  info: (message: string) => void
  warn: (message: string) => void
}

/**
 * Stage → verify → smoke → swap. Drain must be complete before calling.
 * Returns rather than exits — the caller decides how to restart (daemon
 * exits 0 for its service manager; the CLI prints the outcome).
 */
export async function performUpdate(targetVersion: string, hooks: UpdateHooks): Promise<UpdateResult> {
  if (!isManagedInstall()) {
    return { ok: false, reason: 'not-installed', message: NOT_INSTALLED_MESSAGE }
  }
  const staging = toolStagingDir()
  const tool = toolDir()
  const prev = toolPrevDir()

  const cleanupStaging = () => {
    try {
      fs.rmSync(staging, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  // 1. Stage.
  hooks.info(`staging @yasui.io/runner@${targetVersion} into ${staging}`)
  cleanupStaging()
  fs.mkdirSync(staging, { recursive: true })
  const install = await run('npm', [
    'install',
    '--prefix',
    staging,
    '--no-fund',
    '--no-audit',
    `@yasui.io/runner@${targetVersion}`,
  ])
  if (install.code !== 0) {
    cleanupStaging()
    return { ok: false, reason: 'stage-failed', message: `npm install failed: ${install.stderr.slice(0, 2000)}` }
  }

  // 2. Verify provenance/signatures — any failure aborts and deletes staging (04 §12).
  hooks.info('verifying registry signatures + provenance (npm audit signatures)')
  const audit = await run('npm', ['audit', 'signatures', '--prefix', staging])
  if (audit.code !== 0) {
    cleanupStaging()
    return {
      ok: false,
      reason: 'verify-failed',
      message: `npm audit signatures failed — refusing the update: ${audit.stderr.slice(0, 2000)}`,
    }
  }

  // 3. Smoke: --version + protocol fixture self-check with the target node.
  const stagedEntry = installedCliEntry(staging)
  if (!fs.existsSync(stagedEntry)) {
    cleanupStaging()
    return { ok: false, reason: 'smoke-failed', message: `staged install is missing ${stagedEntry}` }
  }
  const versionSmoke = await run(process.execPath, [stagedEntry, '--version'], 60_000)
  if (versionSmoke.code !== 0) {
    cleanupStaging()
    return { ok: false, reason: 'smoke-failed', message: `staged CLI --version failed: ${versionSmoke.stderr.slice(0, 2000)}` }
  }
  const selfCheck = await run(process.execPath, [stagedEntry, 'selfcheck'], 60_000)
  if (selfCheck.code !== 0) {
    cleanupStaging()
    return {
      ok: false,
      reason: 'smoke-failed',
      message: `staged protocol self-check failed: ${(selfCheck.stderr || selfCheck.stdout).slice(0, 2000)}`,
    }
  }

  // 4. Swap (same-fs renames — atomic). Keep tool.prev for one generation.
  try {
    fs.rmSync(prev, { recursive: true, force: true })
    fs.renameSync(tool, prev)
    fs.renameSync(staging, tool)
  } catch (err) {
    // Roll back if we got half-way.
    try {
      if (!fs.existsSync(tool) && fs.existsSync(prev)) fs.renameSync(prev, tool)
    } catch {
      /* the shim's tool.prev fallback covers this */
    }
    return { ok: false, reason: 'swap-failed', message: `atomic swap failed: ${(err as Error).message}` }
  }

  // Marker: on first hello.ack post-update, the daemon deletes tool.prev (04 §12 step 5).
  try {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      updateMarkerPath(),
      JSON.stringify({ from: RUNNER_VERSION, to: targetVersion, at: new Date().toISOString() }) + '\n',
    )
  } catch {
    /* non-fatal */
  }

  hooks.info(`updated @yasui.io/runner ${RUNNER_VERSION} → ${targetVersion}`)
  return { ok: true, from: RUNNER_VERSION, to: targetVersion }
}

/** Called by the daemon after the first successful hello.ack post-update. */
export function finalizeUpdateIfPending(log: { info: (msg: string) => void }): void {
  const marker = updateMarkerPath()
  if (!fs.existsSync(marker)) return
  try {
    fs.rmSync(toolPrevDir(), { recursive: true, force: true })
    fs.unlinkSync(marker)
    log.info('post-update hello.ack confirmed — removed tool.prev rollback copy')
  } catch {
    /* retry next connect */
  }
}
