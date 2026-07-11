/**
 * WsClient — the relay/v1 client state machine (04 §8.1; wire semantics 02 §§2–4, 9–10).
 *
 * - Single `ws` connection, headers `authorization: Bearer <token>` +
 *   `x-yasui-runner-version`. First frame `hello`; `runner.config` follows
 *   immediately after `hello.ack`, then outbox replay.
 * - Reconnect: exponential backoff 1 s → 30 s cap, full jitter, reset after
 *   60 s stable. Close-code handling per 02 §11 / 04 §8.1:
 *   4003 → exit 0 (superseded) · 4013 → re-pair message, exit 0 ·
 *   4004 → wait ≥ 30 s · 4001/HTTP 401 → re-read config once (rotate-token may
 *   have swapped it), else treat as 4013 · 4002 → exit 0 with update hint.
 * - Heartbeat every hello.ack.heartbeatIntervalMs (20 s) with
 *   { activeSessions, load1, freeMemMb }; a missing heartbeat.ack for 10 s
 *   tears the link down.
 * - Inbound frames zod-parsed with `parseServerFrame`; unknown types are
 *   ignored (forward compat). Session-scoped commands are deduped against a
 *   per-session LRU of 1 024 applied frame ids, then `cmd.ack`ed (batched ≤ 50 ms).
 */

import os from 'node:os'
import WebSocket from 'ws'
import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  RELAY_LIMITS,
  RELAY_ERROR_CODES,
  parseServerFrame,
  type EventAckPayload,
  type HelloAckPayload,
  type HelloPayload,
  type RelayFrame,
  type RunnerConfigPayload,
  type RunnerToServerFrame,
  type ServerToRunnerFrame,
} from '@yasui.io/runner-protocol'
import type { Logger } from '../log/logger.js'
import { frameId } from '../util/ids.js'

export const HEARTBEAT_ACK_TIMEOUT_MS = 10_000
export const HELLO_ACK_TIMEOUT_MS = 15_000
export const BACKOFF_BASE_MS = 1_000
export const BACKOFF_CAP_MS = 30_000
export const STABLE_RESET_MS = 60_000
export const RATE_LIMIT_WAIT_MS = 30_000
export const CMD_ACK_FLUSH_MS = 50
export const CMD_LRU_SIZE = 1_024
export const MAX_PENDING_DISPATCH = 1_000
export const SEND_BUFFER_HIGH_WATER = 1024 * 1024

/** Server frames that require a cmd.ack + per-session dedupe (02 §8). */
const SESSION_COMMAND_TYPES: ReadonlySet<string> = new Set([
  'session.start',
  'session.message',
  'session.slash',
  'session.interrupt',
  'session.setModel',
  'session.setPermissionMode',
  'permission.verdict',
  'session.end',
])

/**
 * Config-mirroring commands whose FAILED apply must NOT be acked: the server
 * persists model/permissionMode on cmd.ack (routes 200), so acking a throw
 * would record state the harness never applied — withholding the ack 504s the
 * route and persists nothing. The DB-backed at-least-once frames
 * (message/slash/start/end/verdict) keep ack-on-failure: redelivery must stop.
 */
const NO_ACK_ON_FAILURE_TYPES: ReadonlySet<string> = new Set(['session.setModel', 'session.setPermissionMode'])

class LruSet {
  private readonly map = new Map<string, true>()
  constructor(private readonly max: number) {}
  has(id: string): boolean {
    return this.map.has(id)
  }
  add(id: string): void {
    if (this.map.has(id)) this.map.delete(id)
    this.map.set(id, true)
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
  }
  delete(id: string): void {
    this.map.delete(id)
  }
}

export interface WsConnectionInfo {
  relayUrl: string
  token: string
}

export interface WsClientHooks {
  /** Fresh connection info per attempt (config may have been rotated). */
  connection: () => WsConnectionInfo
  /** 4001 handler: force re-read of config.json; return null when unreadable. */
  refreshConnection: () => WsConnectionInfo | null
  buildHello: () => Omit<HelloPayload, 'protocolVersion' | 'minProtocolVersion' | 'runnerVersion'>
  buildRunnerConfig: () => RunnerConfigPayload
  /** hello.ack — resume reconciliation happens here (SessionManager). */
  onHelloAck: (payload: HelloAckPayload) => void | Promise<void>
  /** Replay unacked outbox frames in order (called right after runner.config). */
  replay: (send: (frame: RelayFrame) => void) => void | Promise<void>
  /** Every non-handshake server frame (commands, acks are routed separately). */
  onCommand: (frame: ServerToRunnerFrame) => void | Promise<void>
  onEventAck: (payload: EventAckPayload) => void
  activeSessions: () => number
  /** Terminal conditions (4003/4013/4002…) — daemon maps this to process.exit. */
  onFatal: (info: { exitCode: number; message: string }) => void
  onConnected?: () => void
  onDisconnected?: () => void
}

export interface WsClientOptions {
  runnerVersion: string
  log: Logger
  hooks: WsClientHooks
  /** Test knobs. */
  backoffBaseMs?: number
  backoffCapMs?: number
  stableResetMs?: number
  heartbeatAckTimeoutMs?: number
  helloAckTimeoutMs?: number
  rateLimitWaitMs?: number
  cmdAckFlushMs?: number
}

type State = 'idle' | 'connecting' | 'awaiting-hello-ack' | 'connected' | 'backoff' | 'stopped'

export class WsClient {
  private ws: WebSocket | null = null
  private state: State = 'idle'
  private attempt = 0
  private connectedAt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatAckTimer: ReturnType<typeof setTimeout> | null = null
  private helloAckTimer: ReturnType<typeof setTimeout> | null = null
  private cmdAckBuffer: string[] = []
  private cmdAckTimer: ReturnType<typeof setTimeout> | null = null
  private readonly appliedCommands = new Map<string, LruSet>()
  private tokenUsed: string | null = null
  private triedRefreshedToken = false
  private pendingDispatch = 0
  private dispatchChain: Promise<void> = Promise.resolve()
  /** True once hooks.replay() has resolved for the CURRENT connection (02 §9). */
  private replayDone = false
  private heldStats: RelayFrame | null = null
  private heldDiff = new Map<string, RelayFrame>()
  private controlQueue: RelayFrame[] = []

  private readonly log: Logger
  private readonly hooks: WsClientHooks
  private readonly backoffBaseMs: number
  private readonly backoffCapMs: number
  private readonly stableResetMs: number
  private readonly heartbeatAckTimeoutMs: number
  private readonly helloAckTimeoutMs: number
  private readonly rateLimitWaitMs: number
  private readonly cmdAckFlushMs: number

  constructor(private readonly opts: WsClientOptions) {
    this.log = opts.log
    this.hooks = opts.hooks
    this.backoffBaseMs = opts.backoffBaseMs ?? BACKOFF_BASE_MS
    this.backoffCapMs = opts.backoffCapMs ?? BACKOFF_CAP_MS
    this.stableResetMs = opts.stableResetMs ?? STABLE_RESET_MS
    this.heartbeatAckTimeoutMs = opts.heartbeatAckTimeoutMs ?? HEARTBEAT_ACK_TIMEOUT_MS
    this.helloAckTimeoutMs = opts.helloAckTimeoutMs ?? HELLO_ACK_TIMEOUT_MS
    this.rateLimitWaitMs = opts.rateLimitWaitMs ?? RATE_LIMIT_WAIT_MS
    this.cmdAckFlushMs = opts.cmdAckFlushMs ?? CMD_ACK_FLUSH_MS
  }

  get connected(): boolean {
    return this.state === 'connected'
  }

  get currentState(): State {
    return this.state
  }

  start(): void {
    if (this.state !== 'idle' && this.state !== 'stopped') return
    this.state = 'connecting'
    this.connect()
  }

  /** Graceful stop (yasui-runner stop / drain complete): close 1000, no reconnect. */
  stop(code = 1000, reason = 'shutdown'): void {
    this.state = 'stopped'
    this.clearTimers()
    if (this.ws) {
      try {
        this.ws.close(code, reason)
      } catch {
        /* ignore */
      }
      this.ws = null
    }
  }

  /** Token/relayUrl changed (rotate-token) — tear down and dial with fresh config. */
  reconnect(): void {
    if (this.state === 'stopped') {
      this.state = 'connecting'
      this.connect()
      return
    }
    this.teardown('manual-reconnect', 0)
  }

  /* ---------- outbound ---------- */

  private rawSend(frame: RelayFrame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    try {
      this.ws.send(JSON.stringify(frame))
      return true
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'ws send failed')
      return false
    }
  }

  envelope<T>(type: string, payload: T, sessionId?: string): RelayFrame<string, T> {
    return {
      id: frameId(),
      type,
      ...(sessionId ? { sessionId } : {}),
      ts: new Date().toISOString(),
      payload,
    }
  }

  /**
   * Durable frames (events + session lifecycle): send when live; outbox replays
   * otherwise. Gated behind outbox replay (02 §3/§9: "the runner replays unacked
   * event frames, then normal traffic flows") — a live adapter must not put a
   * NEWER event revision on the wire before OLDER unacked revisions replay, or
   * the server's arrival-order seq renders the stale revision permanently.
   * Callers already outbox-buffer these frames, so replay delivers them in order.
   */
  sendDurable(frame: RelayFrame): boolean {
    if (this.state !== 'connected' || !this.replayDone) return false
    return this.rawSend(frame)
  }

  /** RPC/control replies may be produced while durable replay is still gated. */
  sendControl(frame: RelayFrame): boolean {
    if (this.state !== 'connected') return false
    if (this.replayDone) return this.rawSend(frame)
    if (this.controlQueue.length >= 64) return false
    this.controlQueue.push(frame)
    return true
  }

  private flushControlQueue(): void {
    while (this.controlQueue.length > 0) {
      const frame = this.controlQueue[0]!
      if (!this.rawSend(frame)) return
      this.controlQueue.shift()
    }
  }

  /**
   * Droppable frames (02 §10): never enqueued while disconnected; dropped
   * outright when the socket buffer is over the high-water mark — except
   * stats/diff, which are held latest-wins and flushed when the buffer drains.
   */
  sendDroppable(frame: RelayFrame, klass: 'delta' | 'stats' | 'diff'): boolean {
    if (this.state !== 'connected' || !this.ws) return false
    if (this.ws.bufferedAmount > SEND_BUFFER_HIGH_WATER) {
      if (klass === 'stats') this.heldStats = frame
      else if (klass === 'diff' && frame.sessionId) this.heldDiff.set(frame.sessionId, frame)
      return false
    }
    this.flushHeld()
    return this.rawSend(frame)
  }

  private flushHeld(): void {
    if (!this.ws || this.ws.bufferedAmount > SEND_BUFFER_HIGH_WATER) return
    if (this.heldStats) {
      this.rawSend(this.heldStats)
      this.heldStats = null
    }
    for (const [sessionId, frame] of this.heldDiff) {
      this.rawSend(frame)
      this.heldDiff.delete(sessionId)
      if (this.ws.bufferedAmount > SEND_BUFFER_HIGH_WATER) break
    }
  }

  sendError(code: string, message: string, details?: unknown, sessionId?: string): void {
    if (this.state !== 'connected') return
    this.rawSend(this.envelope('error', { code, message, ...(details !== undefined ? { details } : {}) }, sessionId))
  }

  /* ---------- connection lifecycle ---------- */

  private connect(): void {
    let info: WsConnectionInfo
    try {
      info = this.hooks.connection()
    } catch (err) {
      this.hooks.onFatal({ exitCode: 1, message: `cannot read runner config: ${(err as Error).message}` })
      return
    }
    this.tokenUsed = info.token
    this.state = 'connecting'
    const ws = new WebSocket(info.relayUrl, {
      headers: {
        authorization: `Bearer ${info.token}`,
        'x-yasui-runner-version': this.opts.runnerVersion,
      },
      handshakeTimeout: 15_000,
      perMessageDeflate: true,
      maxPayload: RELAY_LIMITS.maxFrameBytes,
    })
    this.ws = ws

    ws.on('open', () => {
      if (this.ws !== ws) return
      this.state = 'awaiting-hello-ack'
      const hello = this.envelope('hello', {
        protocolVersion: PROTOCOL_VERSION,
        minProtocolVersion: MIN_PROTOCOL_VERSION,
        runnerVersion: this.opts.runnerVersion,
        ...this.hooks.buildHello(),
      })
      this.rawSend(hello)
      this.helloAckTimer = setTimeout(() => {
        this.log.warn('no hello.ack — tearing down')
        this.teardown('hello-ack-timeout')
      }, this.helloAckTimeoutMs)
    })

    ws.on('message', (data) => {
      if (this.ws !== ws) return
      this.onMessage(typeof data === 'string' ? data : data.toString())
    })

    ws.on('unexpected-response', (_req, res) => {
      if (this.ws !== ws) return
      const status = res.statusCode ?? 0
      this.log.warn({ status }, 'relay upgrade rejected')
      this.ws = null
      try {
        ws.terminate()
      } catch {
        /* ignore */
      }
      if (status === 401) {
        this.handleUnauthorized()
        return
      }
      this.scheduleReconnect()
    })

    ws.on('error', (err) => {
      if (this.ws !== ws) return
      this.log.debug({ err: err.message }, 'ws error')
      // 'close' follows; reconnect handled there. If no close comes (dial
      // failure), 'close' is still emitted by ws after 'error'.
    })

    ws.on('close', (code, reasonBuf) => {
      if (this.ws !== ws) return
      const reason = reasonBuf.toString()
      this.onClose(code, reason)
    })
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.heartbeatAckTimer) clearTimeout(this.heartbeatAckTimer)
    if (this.helloAckTimer) clearTimeout(this.helloAckTimer)
    if (this.cmdAckTimer) clearTimeout(this.cmdAckTimer)
    this.reconnectTimer = null
    this.heartbeatTimer = null
    this.heartbeatAckTimer = null
    this.helloAckTimer = null
    this.cmdAckTimer = null
  }

  private teardown(why: string, reconnectDelayMs?: number): void {
    this.log.debug({ why }, 'tearing down relay connection')
    const ws = this.ws
    this.ws = null
    this.clearTimers()
    this.cmdAckBuffer = []
    this.heldStats = null
    this.heldDiff.clear()
    this.controlQueue = []
    this.replayDone = false
    if (ws) {
      try {
        ws.terminate()
      } catch {
        /* ignore */
      }
    }
    if (this.state === 'connected') this.hooks.onDisconnected?.()
    if (this.state !== 'stopped') this.scheduleReconnect(reconnectDelayMs)
  }

  private onClose(code: number, reason: string): void {
    const wasConnected = this.state === 'connected'
    this.ws = null
    this.clearTimers()
    this.cmdAckBuffer = []
    this.heldStats = null
    this.heldDiff.clear()
    this.controlQueue = []
    this.replayDone = false
    if (wasConnected) {
      // Stable for >= 60 s → reset backoff (02 §2).
      if (Date.now() - this.connectedAt >= this.stableResetMs) this.attempt = 0
      this.hooks.onDisconnected?.()
    }
    if (this.state === 'stopped') return

    switch (code) {
      case 4003:
        this.state = 'stopped'
        this.hooks.onFatal({ exitCode: 0, message: 'superseded by a newer connection for this runner — exiting' })
        return
      case 4013:
        this.state = 'stopped'
        this.hooks.onFatal({
          exitCode: 0,
          message: 'runner revoked — re-pair with `yasui-runner connect`',
        })
        return
      case 4002:
        this.state = 'stopped'
        this.hooks.onFatal({
          exitCode: 0,
          message: 'relay protocol version unsupported — run `yasui-runner update`',
        })
        return
      case 4001:
        this.handleUnauthorized()
        return
      case 4004:
        this.log.warn({ reason }, 'rate limited by relay — backing off >= 30 s')
        this.scheduleReconnect(Math.max(this.rateLimitWaitMs, this.nextBackoffDelay()))
        return
      case 1012:
        this.scheduleReconnect(0)
        return
      default:
        this.log.info({ code, reason }, 'relay disconnected')
        this.scheduleReconnect()
    }
  }

  /** 4001 / HTTP 401: re-read config once — rotate-token may have swapped the token. */
  private handleUnauthorized(): void {
    if (!this.triedRefreshedToken) {
      this.triedRefreshedToken = true
      const fresh = this.hooks.refreshConnection()
      if (fresh && fresh.token !== this.tokenUsed) {
        this.log.info('token changed on disk — reconnecting with the fresh token')
        this.scheduleReconnect(0)
        return
      }
    }
    this.state = 'stopped'
    this.hooks.onFatal({
      exitCode: 0,
      message: 'runner token rejected — re-pair with `yasui-runner connect`',
    })
  }

  private nextBackoffDelay(): number {
    const expo = Math.min(this.backoffBaseMs * 2 ** this.attempt, this.backoffCapMs)
    return Math.max(50, Math.floor(expo * Math.random()))
  }

  private scheduleReconnect(delayMs?: number): void {
    if (this.state === 'stopped') return
    this.state = 'backoff'
    const delay = delayMs ?? this.nextBackoffDelay()
    this.attempt = Math.min(this.attempt + 1, 10)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.state === 'stopped') return
      this.connect()
    }, delay)
  }

  /* ---------- inbound ---------- */

  private onMessage(raw: string): void {
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      this.log.warn('malformed relay frame (not JSON)')
      return
    }
    const parsed = parseServerFrame(json)
    if (!parsed.ok) {
      if (parsed.reason === 'unknown-type') {
        this.log.debug({ type: parsed.type }, 'ignoring unknown frame type (forward compat)')
      } else {
        this.log.warn({ issues: parsed.error.issues.slice(0, 3) }, 'malformed relay frame')
      }
      return
    }
    const frame = parsed.frame

    if (frame.type === 'hello.ack') {
      this.onHelloAck(frame.payload as HelloAckPayload)
      return
    }
    if (frame.type === 'heartbeat.ack') {
      if (this.heartbeatAckTimer) {
        clearTimeout(this.heartbeatAckTimer)
        this.heartbeatAckTimer = null
      }
      return
    }
    if (frame.type === 'event.ack') {
      this.hooks.onEventAck(frame.payload as EventAckPayload)
      return
    }

    // Session-scoped command dedupe + cmd.ack (02 §8, 04 §8.1).
    if (SESSION_COMMAND_TYPES.has(frame.type) && frame.sessionId) {
      let lru = this.appliedCommands.get(frame.sessionId)
      if (!lru) {
        lru = new LruSet(CMD_LRU_SIZE)
        this.appliedCommands.set(frame.sessionId, lru)
      }
      if (lru.has(frame.id)) {
        this.enqueueCmdAck(frame.id) // re-ack duplicates; do not re-apply
        return
      }
      lru.add(frame.id)
      if (!this.dispatch(frame, () => this.enqueueCmdAck(frame.id))) lru.delete(frame.id)
      return
    }

    this.dispatch(frame)
  }

  /** Sequential dispatch with a bounded pending queue (08 §4: drop beyond 1000). */
  private dispatch(frame: ServerToRunnerFrame, after?: () => void): boolean {
    if (this.pendingDispatch >= MAX_PENDING_DISPATCH) {
      this.log.error({ type: frame.type }, 'inbound queue full — dropping frame')
      this.sendError(RELAY_ERROR_CODES.runnerInternal, 'inbound command queue full', { dropped: frame.type }, frame.sessionId)
      return false
    }
    this.pendingDispatch++
    this.dispatchChain = this.dispatchChain
      .then(async () => {
        try {
          await this.hooks.onCommand(frame)
          after?.()
        } catch (err) {
          this.log.error({ err: (err as Error).message, type: frame.type }, 'command handler failed')
          this.sendError(RELAY_ERROR_CODES.runnerInternal, `command failed: ${frame.type}`, undefined, frame.sessionId)
          if (NO_ACK_ON_FAILURE_TYPES.has(frame.type)) {
            // No cmd.ack: the server must not persist a model/mode the harness
            // never applied. Un-remember the frame id so a redelivery (same id)
            // re-applies instead of hitting the duplicate re-ack path.
            if (frame.sessionId) this.appliedCommands.get(frame.sessionId)?.delete(frame.id)
          } else {
            after?.() // applied (and failed) — still ack so the server stops redelivering
          }
        }
      })
      .finally(() => {
        this.pendingDispatch--
      })
    return true
  }

  private enqueueCmdAck(id: string): void {
    this.cmdAckBuffer.push(id)
    if (this.cmdAckTimer) return
    this.cmdAckTimer = setTimeout(() => {
      this.cmdAckTimer = null
      const ids = this.cmdAckBuffer
      this.cmdAckBuffer = []
      if (ids.length > 0 && this.state === 'connected') {
        this.rawSend(this.envelope('cmd.ack', { ids }))
      }
    }, this.cmdAckFlushMs)
  }

  private onHelloAck(payload: HelloAckPayload): void {
    if (this.helloAckTimer) {
      clearTimeout(this.helloAckTimer)
      this.helloAckTimer = null
    }
    this.state = 'connected'
    this.connectedAt = Date.now()
    this.triedRefreshedToken = false
    this.log.info({ runnerId: payload.runnerId, heartbeatIntervalMs: payload.heartbeatIntervalMs }, 'relay connected')

    // runner.config right after hello.ack (04 §5), then outbox replay (02 §9).
    // sendDurable stays gated (replayDone=false) until the replay resolves so
    // redelivered commands dispatched meanwhile cannot leapfrog older unacked
    // revisions; the `ws` guard keeps a slow onHelloAck (adapter.stop can take
    // seconds) from replaying into — or ungating — a newer connection.
    this.rawSend(this.envelope('runner.config', this.hooks.buildRunnerConfig()))
    const ws = this.ws
    void (async () => {
      try {
        await this.hooks.onHelloAck(payload)
        if (this.ws !== ws) return
        await this.hooks.replay((frame) => {
          if (this.ws === ws) this.rawSend(frame)
        })
        if (this.ws === ws) {
          this.replayDone = true
          this.flushControlQueue()
        }
      } catch (err) {
        this.log.error({ err: (err as Error).message }, 'hello.ack processing failed')
        // Never leave the link up with durable sends gated forever — reconnect
        // and redo the resume/replay handshake from scratch.
        if (this.ws === ws) this.teardown('hello-ack-processing-failed')
      }
    })()

    const interval = payload.heartbeatIntervalMs > 0 ? payload.heartbeatIntervalMs : RELAY_LIMITS.heartbeatIntervalMs
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), interval)
    this.hooks.onConnected?.()
  }

  private sendHeartbeat(): void {
    if (this.state !== 'connected') return
    this.flushHeld()
    this.rawSend(
      this.envelope('heartbeat', {
        activeSessions: this.hooks.activeSessions(),
        load1: os.loadavg()[0] ?? 0,
        freeMemMb: Math.round(os.freemem() / (1024 * 1024)),
      }),
    )
    if (this.heartbeatAckTimer) clearTimeout(this.heartbeatAckTimer)
    this.heartbeatAckTimer = setTimeout(() => {
      this.heartbeatAckTimer = null
      this.log.warn('heartbeat.ack missing for 10 s — dead link, reconnecting')
      this.teardown('heartbeat-timeout')
    }, this.heartbeatAckTimeoutMs)
  }
}
