/**
 * Outbox — per-session at-least-once buffer for durable frames (04 §8.2, 02 §9).
 *
 * Durable = `event` frames plus the acked session lifecycle frames
 * (`session.started`, `session.status`, `session.ended`) — never
 * `delta`/`session.stats`/`session.diff`.
 *
 * In-memory queue + append-only JSONL spillover `outbox/<sessionId>.jsonl`
 * (fsync'd on `final: true` events only). `event.ack` deletes entries; on
 * reconnect after `hello.ack` every surviving entry is re-sent in order
 * (the server dedupes on `wireFrameId`). Limits per 02 §10: 5 000 frames /
 * 32 MiB — at the limit `waitForCapacity()` blocks the adapter's output loop
 * (natural backpressure). The JSONL file is deleted on `session.ended` ack.
 *
 * The session's `lastAppliedInputSeq` is persisted in the same JSONL (header
 * records; the last one wins on load) so `hello.resume[]` survives a crash.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { RelayFrame } from '@yasui.io/runner-protocol'

export const OUTBOX_MAX_FRAMES = 5_000
export const OUTBOX_MAX_BYTES = 32 * 1024 * 1024

type JsonlRecord =
  | { t: 'h'; lastAppliedInputSeq: number }
  | { t: 'e'; frame: RelayFrame }
  | { t: 'a'; id: string }

export interface SessionOutboxOptions {
  maxFrames?: number
  maxBytes?: number
  /** Called once when disk writes start failing (ENOSPC etc. — 04 §14). */
  onDiskError?: (err: Error) => void
}

export class SessionOutbox {
  private readonly entries = new Map<string, { frame: RelayFrame; bytes: number }>()
  private bytes = 0
  private fd: number | null = null
  private diskBroken = false
  private waiters: Array<() => void> = []
  private lastInputSeq = 0
  private endedFrameId: string | null = null
  private readonly maxFrames: number
  private readonly maxBytes: number

  constructor(
    readonly sessionId: string,
    private readonly filePath: string,
    private readonly opts: SessionOutboxOptions = {},
  ) {
    this.maxFrames = opts.maxFrames ?? OUTBOX_MAX_FRAMES
    this.maxBytes = opts.maxBytes ?? OUTBOX_MAX_BYTES
  }

  /* ---------- state ---------- */

  get depth(): number {
    return this.entries.size
  }

  get byteSize(): number {
    return this.bytes
  }

  get lastAppliedInputSeq(): number {
    return this.lastInputSeq
  }

  /** Unacked frames in append order. */
  pending(): RelayFrame[] {
    return [...this.entries.values()].map((e) => e.frame)
  }

  hasCapacity(): boolean {
    return this.entries.size < this.maxFrames && this.bytes < this.maxBytes
  }

  /** Resolves immediately when below limits, else when acks free capacity (02 §10). */
  waitForCapacity(): Promise<void> {
    if (this.hasCapacity()) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private releaseWaiters(): void {
    if (!this.hasCapacity() || this.waiters.length === 0) return
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) w()
  }

  /* ---------- disk ---------- */

  /** Restore surviving entries + lastAppliedInputSeq from the JSONL spillover. */
  loadFromDisk(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.filePath, 'utf8')
    } catch {
      return
    }
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue
      let record: JsonlRecord
      try {
        record = JSON.parse(line) as JsonlRecord
      } catch {
        continue // torn tail line from a crash mid-append
      }
      if (record.t === 'h') {
        this.lastInputSeq = record.lastAppliedInputSeq
      } else if (record.t === 'e') {
        const bytes = Buffer.byteLength(JSON.stringify(record.frame))
        this.entries.set(record.frame.id, { frame: record.frame, bytes })
        this.bytes += bytes
        if (record.frame.type === 'session.ended') this.endedFrameId = record.frame.id
      } else if (record.t === 'a') {
        const existing = this.entries.get(record.id)
        if (existing) {
          this.bytes -= existing.bytes
          this.entries.delete(record.id)
        }
      }
    }
  }

  private appendLine(record: JsonlRecord, fsync: boolean): void {
    if (this.diskBroken) return
    try {
      if (this.fd === null) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
        this.fd = fs.openSync(this.filePath, 'a', 0o600)
      }
      fs.writeSync(this.fd, JSON.stringify(record) + '\n')
      if (fsync) fs.fsyncSync(this.fd)
    } catch (err) {
      // Disk full: fall back to memory-only, bounded — beyond it, backpressure (04 §14).
      this.diskBroken = true
      this.opts.onDiskError?.(err as Error)
    }
  }

  /* ---------- mutations ---------- */

  /**
   * Buffer a durable frame. fsync applies only to `final: true` events
   * (04 §8.2) and terminal frames.
   */
  push(frame: RelayFrame, opts: { fsync?: boolean } = {}): void {
    const bytes = Buffer.byteLength(JSON.stringify(frame))
    this.entries.set(frame.id, { frame, bytes })
    this.bytes += bytes
    if (frame.type === 'session.ended') this.endedFrameId = frame.id
    this.appendLine({ t: 'e', frame }, opts.fsync === true)
  }

  /**
   * `event.ack` handler. Returns true when this ack completed the session:
   * the session.ended frame is acked and nothing is left unacked — the JSONL
   * file is deleted (04 §8.2).
   */
  ack(frameId: string): boolean {
    const existing = this.entries.get(frameId)
    if (existing) {
      this.bytes -= existing.bytes
      this.entries.delete(frameId)
      this.appendLine({ t: 'a', id: frameId }, false)
      this.releaseWaiters()
    }
    if (this.endedFrameId !== null && !this.entries.has(this.endedFrameId) && this.entries.size === 0) {
      this.deleteFile()
      return true
    }
    return false
  }

  get endedAndDrained(): boolean {
    return this.endedFrameId !== null && this.entries.size === 0
  }

  /** True once a session.ended frame has been buffered (acked or not). */
  get hasEndedFrame(): boolean {
    return this.endedFrameId !== null
  }

  setLastAppliedInputSeq(seq: number): void {
    if (seq <= this.lastInputSeq) return
    this.lastInputSeq = seq
    this.appendLine({ t: 'h', lastAppliedInputSeq: seq }, false)
  }

  /** Discard everything (hello.ack resume state "unknown" — 02 §3). */
  discard(): void {
    this.entries.clear()
    this.bytes = 0
    this.releaseWaiters()
    this.deleteFile()
  }

  deleteFile(): void {
    this.close()
    try {
      fs.unlinkSync(this.filePath)
    } catch {
      /* already gone */
    }
  }

  close(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd)
      } catch {
        /* ignore */
      }
      this.fd = null
    }
  }
}

/** All session outboxes; also restores crash spillovers on boot (04 §14). */
export class OutboxManager {
  private readonly outboxes = new Map<string, SessionOutbox>()

  constructor(
    private readonly dir: string,
    private readonly opts: SessionOutboxOptions = {},
  ) {}

  forSession(sessionId: string): SessionOutbox {
    let outbox = this.outboxes.get(sessionId)
    if (!outbox) {
      outbox = new SessionOutbox(sessionId, path.join(this.dir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`), this.opts)
      this.outboxes.set(sessionId, outbox)
    }
    return outbox
  }

  /** Load every `outbox/*.jsonl` left by a previous process (crash recovery). */
  restoreFromDisk(): SessionOutbox[] {
    let files: string[]
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      return []
    }
    const restored: SessionOutbox[] = []
    for (const file of files) {
      const sessionId = file.slice(0, -'.jsonl'.length)
      if (this.outboxes.has(sessionId)) continue
      const outbox = new SessionOutbox(sessionId, path.join(this.dir, file), this.opts)
      outbox.loadFromDisk()
      this.outboxes.set(sessionId, outbox)
      restored.push(outbox)
    }
    return restored
  }

  all(): SessionOutbox[] {
    return [...this.outboxes.values()]
  }

  remove(sessionId: string): void {
    const outbox = this.outboxes.get(sessionId)
    if (outbox) {
      outbox.close()
      this.outboxes.delete(sessionId)
    }
  }
}
