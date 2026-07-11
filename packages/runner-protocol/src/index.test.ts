import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CLOSE_CODES,
  RELAY_ERROR_CODES,
  parseRunnerFrame,
  parseServerFrame,
} from './index'

const fixturesDir = join(__dirname, '..', 'fixtures')

interface FrameFixture {
  direction: 'runner->server' | 'server->runner'
  frame: unknown
  expect: 'accept' | 'reject'
}

const frameFixtureFiles = readdirSync(fixturesDir)
  .filter((name) => name.endsWith('.json') && name !== 'close-codes.json')
  .sort()

describe('relay/v1 conformance fixtures', () => {
  it('has fixtures to run', () => {
    expect(frameFixtureFiles.length).toBeGreaterThanOrEqual(40)
  })

  for (const name of frameFixtureFiles) {
    it(name, () => {
      const fixture = JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as FrameFixture
      expect(['runner->server', 'server->runner']).toContain(fixture.direction)
      expect(['accept', 'reject']).toContain(fixture.expect)

      const result =
        fixture.direction === 'runner->server'
          ? parseRunnerFrame(fixture.frame)
          : parseServerFrame(fixture.frame)

      if (fixture.expect === 'accept') {
        expect(result).toMatchObject({ ok: true })
      } else {
        expect(result.ok).toBe(false)
        // Rejections must be genuine schema failures, not unknown-type skips —
        // an unknown type would be silently ignored on a live socket, not rejected.
        if (!result.ok) expect(result.reason).toBe('malformed')
      }
    })
  }

  it('close-codes.json matches the exported taxonomy', () => {
    const snapshot = JSON.parse(readFileSync(join(fixturesDir, 'close-codes.json'), 'utf8'))
    expect(snapshot).toEqual({ closeCodes: CLOSE_CODES, errorCodes: RELAY_ERROR_CODES })
  })
})

describe('unknown-type tolerance', () => {
  const ts = '2026-07-06T18:02:11.480Z'

  it('reports unknown frame types as unknown-type, not malformed', () => {
    const result = parseRunnerFrame({ id: 'f_future01', type: 'telemetry.v2', ts, payload: { anything: true } })
    expect(result).toMatchObject({ ok: false, reason: 'unknown-type', type: 'telemetry.v2' })
  })

  it('tolerates unknown payload fields on known frames', () => {
    const result = parseServerFrame({
      id: 'cmd_i43zzzz',
      type: 'session.interrupt',
      sessionId: 'ags_c1abc',
      ts,
      payload: { futureFlag: 'yes' },
    })
    expect(result.ok).toBe(true)
  })
})
