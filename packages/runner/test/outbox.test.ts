import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RelayFrame } from '@yasui.io/runner-protocol'
import { OutboxManager, SessionOutbox } from '../src/daemon/outbox.js'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yasui-outbox-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

let frameCounter = 0
function makeFrame(type = 'event', overrides: Partial<RelayFrame> = {}): RelayFrame {
  frameCounter++
  return {
    id: `f_test${String(frameCounter).padStart(8, '0')}`,
    type,
    sessionId: 'ags_test1',
    ts: '2026-07-06T18:00:00.000Z',
    payload: { event: { id: `ev_${frameCounter}`, at: '2026-07-06T18:00:00.000Z', kind: 'assistant', text: 'hi' } },
    ...overrides,
  }
}

describe('SessionOutbox spillover + replay', () => {
  it('push → JSONL append; ack → deletion record; reload restores survivors in order', () => {
    const file = path.join(dir, 'ags_test1.jsonl')
    const outbox = new SessionOutbox('ags_test1', file)
    const f1 = makeFrame()
    const f2 = makeFrame()
    const f3 = makeFrame()
    outbox.push(f1)
    outbox.push(f2, { fsync: true })
    outbox.push(f3)
    outbox.setLastAppliedInputSeq(42)
    outbox.ack(f2.id)
    outbox.close()

    const reloaded = new SessionOutbox('ags_test1', file)
    reloaded.loadFromDisk()
    expect(reloaded.depth).toBe(2)
    expect(reloaded.pending().map((f) => f.id)).toEqual([f1.id, f3.id])
    expect(reloaded.lastAppliedInputSeq).toBe(42)
    reloaded.close()
  })

  it('tolerates a torn tail line (crash mid-append)', () => {
    const file = path.join(dir, 'ags_test1.jsonl')
    const outbox = new SessionOutbox('ags_test1', file)
    const f1 = makeFrame()
    outbox.push(f1)
    outbox.close()
    fs.appendFileSync(file, '{"t":"e","frame":{"id":"f_torn')
    const reloaded = new SessionOutbox('ags_test1', file)
    reloaded.loadFromDisk()
    expect(reloaded.depth).toBe(1)
    reloaded.close()
  })

  it('session.ended fully acked → JSONL deleted, ack() returns true', () => {
    const file = path.join(dir, 'ags_test1.jsonl')
    const outbox = new SessionOutbox('ags_test1', file)
    const ev = makeFrame()
    const ended = makeFrame('session.ended', {
      payload: { reason: 'completed', resultSummary: null, errorText: null },
    })
    outbox.push(ev)
    outbox.push(ended, { fsync: true })
    expect(outbox.ack(ev.id)).toBe(false)
    expect(fs.existsSync(file)).toBe(true)
    expect(outbox.ack(ended.id)).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('acking an unknown frame id is harmless', () => {
    const outbox = new SessionOutbox('ags_test1', path.join(dir, 'x.jsonl'))
    expect(outbox.ack('f_never_seen')).toBe(false)
  })
})

describe('SessionOutbox capacity backpressure (02 §10)', () => {
  it('waitForCapacity resolves immediately below the limit', async () => {
    const outbox = new SessionOutbox('ags_test1', path.join(dir, 'a.jsonl'), { maxFrames: 5 })
    outbox.push(makeFrame())
    await expect(outbox.waitForCapacity()).resolves.toBeUndefined()
  })

  it('blocks at maxFrames and unblocks on ack', async () => {
    const outbox = new SessionOutbox('ags_test1', path.join(dir, 'b.jsonl'), { maxFrames: 3 })
    const frames = [makeFrame(), makeFrame(), makeFrame()]
    for (const f of frames) outbox.push(f)
    expect(outbox.hasCapacity()).toBe(false)

    let resolved = false
    const wait = outbox.waitForCapacity().then(() => {
      resolved = true
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(resolved).toBe(false)

    outbox.ack(frames[0]!.id)
    await wait
    expect(resolved).toBe(true)
  })

  it('blocks at maxBytes too', async () => {
    const outbox = new SessionOutbox('ags_test1', path.join(dir, 'c.jsonl'), { maxBytes: 200 })
    outbox.push(makeFrame())
    outbox.push(makeFrame())
    expect(outbox.hasCapacity()).toBe(false)
    outbox.discard()
    expect(outbox.hasCapacity()).toBe(true)
  })

  it('discard releases waiters and deletes the file', async () => {
    const file = path.join(dir, 'd.jsonl')
    const outbox = new SessionOutbox('ags_test1', file, { maxFrames: 1 })
    outbox.push(makeFrame())
    const wait = outbox.waitForCapacity()
    outbox.discard()
    await wait
    expect(fs.existsSync(file)).toBe(false)
    expect(outbox.depth).toBe(0)
  })
})

describe('SessionOutbox disk-failure fallback (04 §14)', () => {
  it('falls back to memory-only and reports once', () => {
    let reports = 0
    const outbox = new SessionOutbox('ags_test1', path.join(dir, 'no-such-dir-parent-is-a-file', 'x.jsonl'), {
      onDiskError: () => {
        reports++
      },
    })
    // Make the parent an unwritable location: create a FILE where the dir should be.
    fs.writeFileSync(path.join(dir, 'no-such-dir-parent-is-a-file'), 'oops')
    outbox.push(makeFrame())
    outbox.push(makeFrame())
    expect(outbox.depth).toBe(2) // memory still works
    expect(reports).toBe(1) // reported once, then silent
  })
})

describe('OutboxManager crash restore', () => {
  it('restoreFromDisk loads every jsonl left behind', () => {
    const m1 = new OutboxManager(dir)
    const a = m1.forSession('ags_a')
    const b = m1.forSession('ags_b')
    a.push(makeFrame())
    a.setLastAppliedInputSeq(7)
    b.push(makeFrame())
    b.push(makeFrame())
    for (const outbox of m1.all()) outbox.close()

    const m2 = new OutboxManager(dir)
    const restored = m2.restoreFromDisk()
    expect(restored.map((o) => o.sessionId).sort()).toEqual(['ags_a', 'ags_b'])
    expect(m2.forSession('ags_a').depth).toBe(1)
    expect(m2.forSession('ags_a').lastAppliedInputSeq).toBe(7)
    expect(m2.forSession('ags_b').depth).toBe(2)
  })
})
