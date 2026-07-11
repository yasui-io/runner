import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitResultPayload, WireSessionEvent } from '@yasui.io/runner-protocol'
import {
  redact,
  redactDeep,
  redactDelta,
  redactEvent,
  registerSessionSecret,
  unregisterSessionSecret,
} from '../src/redact.js'

const FIXTURES_DIR = path.resolve(__dirname, '..', '..', 'runner-protocol', 'fixtures', 'redaction')

interface RedactionFixture {
  label: string
  cases: Array<{ name: string; input: string; expected: string; sessionSecrets?: string[] }>
}

afterEach(() => {
  // Tests register secrets under deterministic ids — always clean up.
  for (let i = 0; i < 8; i++) unregisterSessionSecret(`test-${i}`)
})

describe('redaction conformance fixtures (08 §4 table)', () => {
  const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'))

  it('covers every pattern label in the canonical table', () => {
    const labels = files.map((f) => (JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf8')) as RedactionFixture).label)
    for (const required of [
      'session-key-exact',
      'aws-key-id',
      'aws-secret',
      'github-token',
      'anthropic-key',
      'openai-key',
      'yasui-key',
      'yasui-runner-token',
      'jwt',
      'private-key',
      'bearer-header',
      'env-assignment',
    ]) {
      expect(labels, `missing fixture for ${required}`).toContain(required)
    }
  })

  for (const file of files) {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8')) as RedactionFixture
    describe(fixture.label, () => {
      for (const testCase of fixture.cases) {
        it(testCase.name, () => {
          const secrets = testCase.sessionSecrets ?? []
          secrets.forEach((secret, i) => registerSessionSecret(`test-${i}`, secret))
          try {
            expect(redact(testCase.input)).toBe(testCase.expected)
          } finally {
            secrets.forEach((_s, i) => unregisterSessionSecret(`test-${i}`))
          }
        })
      }
    })
  }
})

describe('redact() unit behavior', () => {
  it('session-key exact match is checked before patterns', () => {
    registerSessionSecret('test-0', 'plain-secret-with-no-pattern-shape')
    expect(redact('leak: plain-secret-with-no-pattern-shape!')).toBe('leak: [redacted:session-key]!')
  })

  it('is a no-op on clean text', () => {
    const text = 'nothing secret here — just code: const x = 1'
    expect(redact(text)).toBe(text)
  })

  it('redaction happens before truncation could split a secret (pattern spans the whole block)', () => {
    const key = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(100_000)}\n-----END PRIVATE KEY-----`
    expect(redact(key)).toBe('[redacted:private-key]')
  })
})

describe('redactEvent — assistant/thinking excluded (08 §4)', () => {
  const token = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'

  it('leaves assistant text untouched', () => {
    const event: WireSessionEvent = { id: 'ev_1', at: '2026-07-06T18:00:00.000Z', kind: 'assistant', text: `model said ${token}` }
    expect(redactEvent(event)).toBe(event)
  })

  it('leaves thinking text untouched', () => {
    const event: WireSessionEvent = { id: 'ev_2', at: '2026-07-06T18:00:00.000Z', kind: 'thinking', text: token }
    expect(redactEvent(event)).toBe(event)
  })

  it('scrubs tool call output/input/error deep fields', () => {
    const event: WireSessionEvent = {
      id: 'ev_3',
      at: '2026-07-06T18:00:00.000Z',
      kind: 'tool',
      call: {
        id: 'tc_1',
        name: 'Bash',
        summary: `echo ${token}`,
        status: 'success',
        input: `git push https://${token}@github.com/a/b`,
        output: `remote used ${token}`,
      },
    }
    const redacted = redactEvent(event)
    expect(redacted).not.toBe(event)
    if (redacted.kind !== 'tool') throw new Error('kind changed')
    expect(redacted.call.summary).toBe('echo [redacted:github-token]')
    expect(redacted.call.input).toBe('git push https://[redacted:github-token]@github.com/a/b')
    expect(redacted.call.output).toBe('remote used [redacted:github-token]')
  })

  it('scrubs permission input values deeply', () => {
    const event: WireSessionEvent = {
      id: 'ev_4',
      at: '2026-07-06T18:00:00.000Z',
      kind: 'permission',
      tool: 'Bash',
      request: `run with ${token}`,
      status: 'pending',
      toolUseId: 'toolu_1',
      input: { command: `curl -H 'authorization: bearer ${token}'`, nested: { arr: [token] } },
      expiresAt: '2026-07-06T18:15:00.000Z',
    }
    const redacted = redactEvent(event)
    if (redacted.kind !== 'permission') throw new Error('kind changed')
    expect(redacted.request).toBe('run with [redacted:github-token]')
    expect(JSON.stringify(redacted.input)).not.toContain(token)
  })

  it('scrubs error events', () => {
    const event: WireSessionEvent = { id: 'ev_5', at: '2026-07-06T18:00:00.000Z', kind: 'error', text: `boom ${token}` }
    const redacted = redactEvent(event)
    if (redacted.kind !== 'error') throw new Error('kind changed')
    expect(redacted.text).toBe('boom [redacted:github-token]')
  })
})

describe('redactDelta', () => {
  const token = 'yr_AbCdEfGhIjKlMnOpQrStUvWx'

  it('assistant/thinking deltas pass through (model output)', () => {
    const delta = { target: 'assistant' as const, eventId: 'ev_1', offset: 0, text: token }
    expect(redactDelta(delta)).toBe(delta)
  })

  it('tool-output deltas are redacted', () => {
    const delta = { target: 'tool-output' as const, eventId: 'ev_1', toolCallId: 'tc_1', offset: 0, text: `x ${token}` }
    expect(redactDelta(delta).text).toBe('x [redacted:yasui-runner-token]')
  })
})

describe('redactDeep on git.result payloads (04 §13 — daemon.handleGitRequest)', () => {
  it('scrubs secrets from diff.file hunk lines', () => {
    const payload: GitResultPayload = {
      opId: 'op_1',
      op: 'diff.file',
      ok: true,
      result: {
        path: '.env',
        status: 'modified',
        additions: 2,
        deletions: 0,
        hunks: [
          {
            header: '@@ -1,1 +1,3 @@',
            lines: [
              { kind: 'add', text: 'YASUI_INFERENCE=yk_live_0123456789abcdef' },
              { kind: 'add', text: 'aws id AKIAABCDEFGHIJKLMNOP' },
              { kind: 'ctx', text: 'PORT=3000' },
            ],
          },
        ],
      },
    }
    const redacted = redactDeep(payload)
    const json = JSON.stringify(redacted)
    expect(json).not.toContain('yk_live_0123456789abcdef')
    expect(json).not.toContain('AKIAABCDEFGHIJKLMNOP')
    expect(json).toContain('[redacted:yasui-key]')
    expect(json).toContain('[redacted:aws-key-id]')
    expect(json).toContain('PORT=3000') // clean lines untouched
  })

  it('scrubs stderr on error results (git push echoes credentialed remotes)', () => {
    const token = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    const payload: GitResultPayload = {
      opId: 'op_2',
      op: 'push',
      ok: false,
      error: {
        code: 'yasui_runner_git_failed',
        message: 'git push failed (exit 128)',
        stderr: `fatal: unable to access 'https://${token}@github.com/a/b.git'`,
      },
    }
    const redacted = redactDeep(payload) as Extract<GitResultPayload, { ok: false }>
    expect(redacted.error.stderr).toContain('[redacted:github-token]')
    expect(redacted.error.stderr).not.toContain(token)
  })
})
