/**
 * `yasui-runner selfcheck` (hidden) — the protocol self-check used by the
 * self-update smoke step (04 §12 step 3): parse every bundled conformance
 * fixture with the installed @yasui.io/runner-protocol schemas and verify the
 * expected accept/reject outcome, plus the redaction fixtures.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Command } from 'commander'
import { parseRunnerFrame, parseServerFrame } from '@yasui.io/runner-protocol'
import { redact, registerSessionSecret, unregisterSessionSecret } from '../redact.js'

const require = createRequire(import.meta.url)

/** Locate @yasui.io/runner-protocol's fixtures dir in installed or workspace layouts. */
export function findFixturesDir(): string | null {
  const candidates: string[] = []
  try {
    // exports '.' → src/index.ts; fixtures sit next to src/.
    const entry = require.resolve('@yasui.io/runner-protocol')
    candidates.push(path.join(path.dirname(entry), '..', 'fixtures'))
  } catch {
    /* not resolvable */
  }
  // Workspace layout fallback: packages/runner/src/cli → ../../../runner-protocol/fixtures.
  const here = path.dirname(new URL(import.meta.url).pathname)
  candidates.push(path.resolve(here, '..', '..', '..', 'runner-protocol', 'fixtures'))
  candidates.push(path.resolve(here, '..', '..', 'node_modules', '@yasui', 'runner-protocol', 'fixtures'))
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate
    } catch {
      /* keep looking */
    }
  }
  return null
}

interface FrameFixture {
  direction: 'runner->server' | 'server->runner'
  frame: unknown
  expect?: 'accept' | 'reject'
}

interface RedactionFixture {
  label: string
  cases: Array<{ name: string; input: string; expected: string; sessionSecrets?: string[] }>
}

export function runSelfCheck(fixturesDir: string): { checked: number; failures: string[] } {
  const failures: string[] = []
  let checked = 0

  const frameFiles = fs
    .readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.json') && f !== 'close-codes.json')
    .sort()
  for (const file of frameFiles) {
    let fixture: FrameFixture
    try {
      fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf8')) as FrameFixture
    } catch (err) {
      failures.push(`${file}: unreadable (${(err as Error).message})`)
      continue
    }
    if (!fixture.direction || fixture.frame === undefined) continue // taxonomy snapshots etc.
    const result =
      fixture.direction === 'runner->server' ? parseRunnerFrame(fixture.frame) : parseServerFrame(fixture.frame)
    const accepted = result.ok
    const expected = (fixture.expect ?? 'accept') === 'accept'
    checked++
    if (accepted !== expected) {
      failures.push(`${file}: expected ${expected ? 'accept' : 'reject'}, got ${accepted ? 'accept' : 'reject'}`)
    }
  }

  const redactionDir = path.join(fixturesDir, 'redaction')
  if (fs.existsSync(redactionDir)) {
    for (const file of fs.readdirSync(redactionDir).filter((f) => f.endsWith('.json')).sort()) {
      let fixture: RedactionFixture
      try {
        fixture = JSON.parse(fs.readFileSync(path.join(redactionDir, file), 'utf8')) as RedactionFixture
      } catch (err) {
        failures.push(`redaction/${file}: unreadable (${(err as Error).message})`)
        continue
      }
      for (const testCase of fixture.cases) {
        const secrets = testCase.sessionSecrets ?? []
        secrets.forEach((secret, i) => registerSessionSecret(`selfcheck-${i}`, secret))
        const actual = redact(testCase.input)
        secrets.forEach((_secret, i) => unregisterSessionSecret(`selfcheck-${i}`))
        checked++
        if (actual !== testCase.expected) {
          failures.push(`redaction/${file} → ${testCase.name}: got ${JSON.stringify(actual)}`)
        }
      }
    }
  }

  return { checked, failures }
}

export function registerSelfCheck(program: Command): void {
  program
    .command('selfcheck', { hidden: true })
    .description('parse all bundled protocol + redaction fixtures (self-update smoke step)')
    .action(() => {
      const dir = findFixturesDir()
      if (!dir) {
        process.stderr.write('selfcheck: cannot locate @yasui.io/runner-protocol fixtures\n')
        process.exitCode = 1
        return
      }
      const { checked, failures } = runSelfCheck(dir)
      if (failures.length > 0) {
        for (const failure of failures) process.stderr.write(`✘ ${failure}\n`)
        process.stderr.write(`selfcheck failed: ${failures.length} of ${checked} checks\n`)
        process.exitCode = 1
        return
      }
      process.stdout.write(`selfcheck ok — ${checked} fixture checks passed (${dir})\n`)
    })
}
