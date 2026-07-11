/**
 * input-queue tests: push/close semantics, single consumer, SDKUserMessage shape.
 */

import { describe, expect, it } from 'vitest'
import { InputQueue, PushQueue } from '../src/sessions/claude/input-queue'

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iterable) out.push(item)
  return out
}

describe('PushQueue', () => {
  it('delivers buffered items then ends after close', async () => {
    const q = new PushQueue<number>()
    q.push(1)
    q.push(2)
    q.close()
    expect(await collect(q)).toEqual([1, 2])
  })

  it('wakes a waiting consumer on push and on close', async () => {
    const q = new PushQueue<string>()
    const resultPromise = collect(q)
    q.push('a')
    await new Promise((r) => setTimeout(r, 0))
    q.push('b')
    q.close()
    expect(await resultPromise).toEqual(['a', 'b'])
  })

  it('throws on push after close and on a second consumer', () => {
    const q = new PushQueue<number>()
    q.close()
    expect(() => q.push(1)).toThrow('closed')

    const q2 = new PushQueue<number>()
    q2[Symbol.asyncIterator]()
    expect(() => q2[Symbol.asyncIterator]()).toThrow('single consumer')
  })

  it('iterator return() closes the queue', async () => {
    const q = new PushQueue<number>()
    q.push(1)
    const it = q[Symbol.asyncIterator]()
    expect(await it.next()).toEqual({ value: 1, done: false })
    await it.return!()
    expect(q.closed).toBe(true)
  })
})

describe('InputQueue', () => {
  it('yields §2-shaped SDKUserMessages for pushed text', async () => {
    const q = new InputQueue()
    q.pushText('hello agent')
    q.pushText('/compact')
    q.close()
    expect(await collect(q)).toEqual([
      { type: 'user', message: { role: 'user', content: 'hello agent' }, parent_tool_use_id: null },
      { type: 'user', message: { role: 'user', content: '/compact' }, parent_tool_use_id: null },
    ])
  })
})
