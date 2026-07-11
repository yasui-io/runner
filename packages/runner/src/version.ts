/**
 * Runner version + installed-harness detection.
 *
 * The Claude Code CLI is pinned by the @anthropic-ai/claude-agent-sdk version
 * — the SDK version IS the harness update channel (04 §3), so it doubles as
 * the harness version when the bundled CLI version can't be read.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { HarnessInstall } from '@yasui.io/runner-protocol'

const require = createRequire(import.meta.url)

function readOwnPackageJson(): { version?: string } {
  // src/version.ts → ../package.json; dist/cli/index.js (bundle) → ../../package.json.
  const candidates = [
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'package.json'),
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'package.json'),
  ]
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string; version?: string }
      if (parsed.name === '@yasui.io/runner') return parsed
    } catch {
      /* keep looking */
    }
  }
  return {}
}

export const RUNNER_VERSION: string = readOwnPackageJson().version ?? '0.0.0'

/** SDK package version, or null when the SDK is not installed/resolvable. */
export function claudeSdkVersion(): string | null {
  try {
    const pkgPath = require.resolve('@anthropic-ai/claude-agent-sdk/package.json')
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string }
    return parsed.version ?? null
  } catch {
    // `exports` may block package.json; fall back to resolving the entry and walking up.
    try {
      const entry = require.resolve('@anthropic-ai/claude-agent-sdk')
      let dir = path.dirname(entry)
      for (let i = 0; i < 5; i++) {
        const candidate = path.join(dir, 'package.json')
        if (fs.existsSync(candidate)) {
          const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string; version?: string }
          if (parsed.name === '@anthropic-ai/claude-agent-sdk') return parsed.version ?? null
        }
        dir = path.dirname(dir)
      }
    } catch {
      /* not installed */
    }
    return null
  }
}

/** Installed harnesses advertised in `hello` (02 §3). */
export function detectHarnesses(): HarnessInstall[] {
  const sdkVersion = claudeSdkVersion()
  if (!sdkVersion) return []
  return [{ harness: 'claude-code', version: sdkVersion, sdkVersion }]
}
