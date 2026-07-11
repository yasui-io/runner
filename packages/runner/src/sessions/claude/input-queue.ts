/**
 * Push-based AsyncIterable used in two places:
 *  - `InputQueue` — the `prompt` for `query()` in streaming input mode (05 §2):
 *    an AsyncIterable<SDKUserMessage> the adapter pushes user text into.
 *  - the adapter's own `output()` stream (AsyncIterable<AdapterOutput>).
 *
 * Backpressure-free by design (messages are small; 05 §2), unbounded buffer,
 * single consumer (a second iterator request throws).
 */

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

interface Waiter<T> {
  resolve(result: IteratorResult<T>): void
}

export class PushQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = []
  private waiter: Waiter<T> | null = null
  private isClosed = false
  private consumed = false

  get closed(): boolean {
    return this.isClosed
  }

  get size(): number {
    return this.buffer.length
  }

  /** Enqueue an item. Throws if the queue was closed. */
  push(item: T): void {
    if (this.isClosed) throw new Error('PushQueue is closed')
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w.resolve({ value: item, done: false })
      return
    }
    this.buffer.push(item)
  }

  /** Ends iteration once the buffer drains. Idempotent. */
  close(): void {
    if (this.isClosed) return
    this.isClosed = true
    if (this.waiter && this.buffer.length === 0) {
      const w = this.waiter
      this.waiter = null
      w.resolve({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consumed) throw new Error('PushQueue supports a single consumer')
    this.consumed = true
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false })
        }
        if (this.isClosed) {
          return Promise.resolve({ value: undefined as never, done: true })
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiter = { resolve }
        })
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close()
        return Promise.resolve({ value: undefined as never, done: true })
      },
    }
  }
}

/**
 * The streaming-input prompt queue. User messages are yielded exactly as 05 §2
 * specifies: `{ type: 'user', message: { role: 'user', content: text },
 * parent_tool_use_id: null }`. Text only — images/attachments are a locked v1
 * non-goal (05 §11), so this queue never yields content-block arrays.
 */
export class InputQueue extends PushQueue<SDKUserMessage> {
  pushText(text: string): void {
    this.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    })
  }

  /**
   * Init nudge — verified against SDK 0.3.202: a fresh streaming-input query() does
   * NOT emit the `system/init` message until the first user message arrives (the
   * iterator stays silent; `initializationResult()` resolves but lacks session_id/
   * tools). A `shouldQuery: false` empty message makes the CLI emit init (plus a
   * no-op success result the adapter swallows) without an API call or an assistant
   * turn — this is what lets `start()` resolve on init per 05 §1.
   */
  pushInitNudge(): void {
    this.push({
      type: 'user',
      message: { role: 'user', content: '' },
      parent_tool_use_id: null,
      shouldQuery: false,
    })
  }
}
