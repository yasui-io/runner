import { describe, expect, it } from 'vitest'
import { RELAY_LIMITS, type WireSessionEvent } from '@yasui.io/runner-protocol'
import { capEvent, truncateHeadTail } from '../src/sessions/truncate.js'

describe('truncateHeadTail (02 §11)', () => {
  it('no-op under the cap', () => {
    expect(truncateHeadTail('short', 1024)).toBe('short')
  })

  it('keeps head and tail with a byte marker', () => {
    const text = 'H'.repeat(40_000) + 'MIDDLE' + 'T'.repeat(40_000)
    const out = truncateHeadTail(text, 10_000)
    expect(Buffer.byteLength(out)).toBeLessThan(12_000)
    expect(out.startsWith('H')).toBe(true)
    expect(out.endsWith('T')).toBe(true)
    expect(out).toMatch(/… \[truncated \d+ bytes\] …/)
    expect(out).not.toContain('MIDDLE')
  })
})

describe('capEvent', () => {
  it('caps tool output at 64 KiB', () => {
    const event: WireSessionEvent = {
      id: 'ev1',
      at: '2026-07-06T18:00:00.000Z',
      kind: 'tool',
      call: { id: 'tc', name: 'Bash', summary: 's', status: 'success', output: 'x'.repeat(200_000) },
    }
    const capped = capEvent(event)
    if (capped.kind !== 'tool') throw new Error('kind changed')
    expect(Buffer.byteLength(capped.call.output ?? '')).toBeLessThanOrEqual(RELAY_LIMITS.maxToolOutputBytes + 128)
    expect(capped.call.output).toContain('[truncated')
  })

  it('leaves small events untouched (same reference)', () => {
    const event: WireSessionEvent = { id: 'ev2', at: '2026-07-06T18:00:00.000Z', kind: 'assistant', text: 'hi' }
    expect(capEvent(event)).toBe(event)
  })

  it('oversized text events get truncated: true', () => {
    const event: WireSessionEvent = {
      id: 'ev3',
      at: '2026-07-06T18:00:00.000Z',
      kind: 'assistant',
      text: 'y'.repeat(RELAY_LIMITS.maxEventBytes + 10_000),
    }
    const capped = capEvent(event) as WireSessionEvent & { truncated?: boolean }
    expect(capped.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(RELAY_LIMITS.maxEventBytes)
  })

  it('caps a permission event whose bulk is the wire-only raw input (02 §11)', () => {
    const event: WireSessionEvent = {
      id: 'ev4',
      at: '2026-07-06T18:00:00.000Z',
      kind: 'permission',
      tool: 'Write',
      request: 'Write · big.txt',
      status: 'pending',
      toolUseId: 'toolu_big',
      input: { file_path: '/tmp/big.txt', content: 'z'.repeat(RELAY_LIMITS.maxEventBytes + 50_000) },
      expiresAt: '2026-07-06T18:15:00.000Z',
    }
    const capped = capEvent(event) as WireSessionEvent & { truncated?: boolean }
    expect(capped.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(RELAY_LIMITS.maxEventBytes)
    if (capped.kind !== 'permission') throw new Error('kind changed')
    expect(capped.toolUseId).toBe('toolu_big')
    expect((capped.input as { content: string }).content).toContain('[truncated')
    expect((capped.input as { file_path: string }).file_path).toBe('/tmp/big.txt')
  })

  it('shrinks many medium string leaves until the frame fits', () => {
    const input: Record<string, unknown> = {}
    for (let i = 0; i < 6; i++) input[`edit_${i}`] = 'q'.repeat(60_000) // each under the 64 KiB leaf cap
    const event: WireSessionEvent = {
      id: 'ev5',
      at: '2026-07-06T18:00:00.000Z',
      kind: 'permission',
      tool: 'MultiEdit',
      request: 'MultiEdit · many.txt',
      status: 'pending',
      toolUseId: 'toolu_many',
      input,
      expiresAt: '2026-07-06T18:15:00.000Z',
    }
    const capped = capEvent(event) as WireSessionEvent & { truncated?: boolean }
    expect(capped.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(RELAY_LIMITS.maxEventBytes)
  })
})
