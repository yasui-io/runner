/**
 * SessionManager (04 §8.3) — owns the live sessions map, the session.start
 * validation chain, command routing to the HarnessAdapter, and the adapter →
 * wire pipeline (redact → truncate → outbox → relay).
 *
 * Adapters are injected as factories (daemon.ts wires `claude-code` →
 * ClaudeCodeAdapter); this module codes strictly against the HarnessAdapter
 * interface.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  RELAY_ERROR_CODES,
  type HarnessId,
  type HelloAckPayload,
  type HelloResumeEntry,
  type PermissionMode,
  type RelayFrame,
  type SessionStartFrame,
  type SessionStatus,
  type SessionStatsPayload,
  type ServerToRunnerFrame,
  type WireSessionEvent,
} from '@yasui.io/runner-protocol'
import type { RunnerConfig } from '../config/config.js'
import { claudeConfigDir, sessionLogPath } from '../config/paths.js'
import type { OutboxManager, SessionOutbox } from '../daemon/outbox.js'
import { DiffWatcher } from '../git/diff-watcher.js'
import { GitService, GitServiceError } from '../git/git-service.js'
import type { Logger } from '../log/logger.js'
import { redact, redactDeep, redactDelta, redactEvent, registerSessionSecret, unregisterSessionSecret } from '../redact.js'
import { createId, eventId, frameId } from '../util/ids.js'
import type { AdapterOutput, HarnessAdapter } from './harness-adapter.js'
import { capEvent } from './truncate.js'

const STATS_COALESCE_MS = 2_000
/** Replay pacing (02 §10): stay under the server's 500-frames/10 s inbound limit. */
export const REPLAY_BATCH_FRAMES = 40
export const REPLAY_BATCH_PAUSE_MS = 1_000
/** Per-session bound on the exact-seq input dedupe set. */
export const INPUT_SEQ_SET_MAX = 1_024

/**
 * Bounded insertion-order set of applied input seqs (02 §9). Dedupe must be by
 * EXACT seq, not a monotonic cursor: a redelivered seq N and a fresh seq N+1
 * can race on one socket right after reconnect — if N+1 applies first, a
 * `seq <= cursor` check would skip N forever (message loss).
 */
class AppliedInputSeqs {
  private readonly seqs = new Set<number>()
  constructor(private readonly max = INPUT_SEQ_SET_MAX) {}
  has(seq: number): boolean {
    return this.seqs.has(seq)
  }
  add(seq: number): void {
    if (this.seqs.has(seq)) return
    this.seqs.add(seq)
    if (this.seqs.size > this.max) {
      const oldest = this.seqs.values().next().value
      if (oldest !== undefined) this.seqs.delete(oldest)
    }
  }
}

/** The relay send surface SessionManager needs (WsClient satisfies it). */
export interface RelayLink {
  readonly connected: boolean
  sendDurable(frame: RelayFrame): boolean
  sendDroppable(frame: RelayFrame, klass: 'delta' | 'stats' | 'diff'): boolean
  sendError(code: string, message: string, details?: unknown, sessionId?: string): void
}

export type AdapterFactory = () => HarnessAdapter

export interface SessionManagerOptions {
  config: () => RunnerConfig
  git: GitService
  outboxes: OutboxManager
  relay: RelayLink
  adapters: Partial<Record<HarnessId, AdapterFactory>>
  log: Logger
}

interface LiveSession {
  sessionId: string
  adapter: HarnessAdapter
  outbox: SessionOutbox
  diffWatcher: DiffWatcher
  /** Project root (realpath). */
  projectPath: string
  /** Resolved cwd — worktree path when a worktree is used. */
  cwd: string
  worktree: string | null
  status: SessionStatus
  ended: boolean
  /** Exact-seq dedupe of applied session.message/slash inputs (02 §9). */
  appliedInputSeqs: AppliedInputSeqs
  statsTimer: ReturnType<typeof setTimeout> | null
  statsPending: SessionStatsPayload | null
  statsLastSentAt: number
}

export class SessionManager {
  private readonly sessions = new Map<string, LiveSession>()
  private draining = false

  constructor(private readonly opts: SessionManagerOptions) {}

  /* ---------- introspection ---------- */

  activeCount(): number {
    return [...this.sessions.values()].filter((s) => !s.ended).length
  }

  sessionSummaries(): Array<{ sessionId: string; project: string; status: SessionStatus }> {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      project: path.basename(s.projectPath),
      status: s.status,
    }))
  }

  outboxDepth(): number {
    return this.opts.outboxes.all().reduce((sum, o) => sum + o.depth, 0)
  }

  /**
   * Working paths of a LIVE session — session-scoped git.request routing
   * resolves against the session's actual cwd (worktree-aware) instead of
   * trusting the wire path; worktree.* ops keep the main repo path (04 §10).
   */
  sessionGitPaths(sessionId: string): { projectPath: string; cwd: string } | null {
    const session = this.sessions.get(sessionId)
    if (!session || session.ended) return null
    return { projectPath: session.projectPath, cwd: session.cwd }
  }

  /** Stop accepting session.start (self-update drain — 04 §12). */
  setDraining(draining: boolean): void {
    this.draining = draining
  }

  get isDraining(): boolean {
    return this.draining
  }

  /* ---------- hello/resume ---------- */

  /** hello.resume[] — live sessions plus crash-restored outboxes (02 §3). */
  resumeEntries(): HelloResumeEntry[] {
    const entries: HelloResumeEntry[] = []
    const liveIds = new Set<string>()
    for (const s of this.sessions.values()) {
      liveIds.add(s.sessionId)
      entries.push({
        sessionId: s.sessionId,
        lastAppliedInputSeq: s.outbox.lastAppliedInputSeq,
        bufferedEventFrames: s.outbox.depth,
        status: s.ended ? 'completed' : s.status,
      })
    }
    for (const outbox of this.opts.outboxes.all()) {
      if (liveIds.has(outbox.sessionId)) continue
      entries.push({
        sessionId: outbox.sessionId,
        lastAppliedInputSeq: outbox.lastAppliedInputSeq,
        bufferedEventFrames: outbox.depth,
        status: 'failed',
      })
    }
    return entries
  }

  /**
   * hello.ack.resume[] reconciliation (02 §3): `unknown` → kill local harness
   * and discard the buffer; `live`/`ending` sessions whose harness died with a
   * previous process get finalized as failed so the replay closes them out.
   */
  async onHelloAck(payload: HelloAckPayload): Promise<void> {
    for (const entry of payload.resume ?? []) {
      const live = this.sessions.get(entry.sessionId)
      const outbox = this.opts.outboxes.all().find((o) => o.sessionId === entry.sessionId)
      if (entry.state === 'unknown') {
        if (live) {
          this.opts.log.warn({ sessionId: entry.sessionId }, 'server does not know session — killing local harness')
          live.ended = true
          live.diffWatcher.stop()
          unregisterSessionSecret(entry.sessionId)
          this.sessions.delete(entry.sessionId)
          try {
            await live.adapter.stop('shutdown')
          } catch {
            /* already dead */
          }
        }
        if (outbox) {
          outbox.discard()
          this.opts.outboxes.remove(entry.sessionId)
        }
        continue
      }
      // live | ending with no local harness (runner crashed and restarted):
      // report the session failed so the control plane can finalize it (04 §14).
      if (!live && outbox && !outbox.hasEndedFrame) {
        outbox.push(this.makeFrame('session.status', { status: 'failed' }, entry.sessionId))
        outbox.push(
          this.makeFrame(
            'session.ended',
            {
              reason: 'failed',
              resultSummary: null,
              errorText: 'runner restarted — harness process was lost',
            },
            entry.sessionId,
          ),
          { fsync: true },
        )
      }
    }
  }

  /**
   * Outbox replay after hello.ack (02 §9) — every surviving entry, in order.
   * Paced under the server's 500-frames/10 s inbound limit (02 §10): ≤ 40
   * frames per second, so a full-tilt replay cannot trip a 4004 mid-replay
   * (which would restart the replay after the ≥ 30 s wait — churn). The awaits
   * yield the event loop, so heartbeats keep flowing during a long replay.
   */
  async replayOutboxes(send: (frame: RelayFrame) => void): Promise<void> {
    let sent = 0
    for (const outbox of this.opts.outboxes.all()) {
      for (const frame of outbox.pending()) {
        send(frame)
        sent++
        if (sent % REPLAY_BATCH_FRAMES === 0) {
          await new Promise((resolve) => setTimeout(resolve, REPLAY_BATCH_PAUSE_MS))
        }
      }
    }
  }

  /** event.ack routing: delete outbox entries; drop drained ended sessions (04 §8.2). */
  handleEventAck(acks: Array<{ frameId: string; sessionId: string }>): void {
    for (const ack of acks) {
      const outbox = this.opts.outboxes.all().find((o) => o.sessionId === ack.sessionId)
      if (!outbox) continue
      const done = outbox.ack(ack.frameId)
      if (done) this.opts.outboxes.remove(ack.sessionId)
    }
  }

  /* ---------- frame helpers ---------- */

  private makeFrame<T>(type: string, payload: T, sessionId: string): RelayFrame<string, T> {
    return { id: frameId(), type, sessionId, ts: new Date().toISOString(), payload }
  }

  private emitDurable(session: LiveSession, type: string, payload: unknown, opts: { fsync?: boolean } = {}): void {
    const frame = this.makeFrame(type, payload, session.sessionId)
    session.outbox.push(frame, opts)
    this.opts.relay.sendDurable(frame)
  }

  private emitEvent(session: LiveSession, event: WireSessionEvent): void {
    let prepared = event
    if (this.opts.config().redactionEnabled) prepared = redactEvent(prepared)
    prepared = capEvent(prepared)
    const frame = this.makeFrame('event', { event: prepared }, session.sessionId)
    session.outbox.push(frame, { fsync: prepared.final === true })
    this.opts.relay.sendDurable(frame)
  }

  private systemEvent(text: string, variant: 'connect' | 'compaction' | 'model-change' | 'info' | 'checkpoint' = 'info'): WireSessionEvent {
    return { id: eventId(), at: new Date().toISOString(), kind: 'system', variant, text, final: true }
  }

  /* ---------- command routing ---------- */

  async handleCommand(frame: ServerToRunnerFrame): Promise<void> {
    switch (frame.type) {
      case 'session.start':
        await this.handleSessionStart(frame as SessionStartFrame)
        return
      case 'session.message': {
        const session = this.requireSession(frame.sessionId)
        if (!session) return
        if (typeof frame.seq === 'number' && session.appliedInputSeqs.has(frame.seq)) return
        await session.adapter.send({ kind: 'message', eventId: frame.payload.eventId, text: frame.payload.text })
        if (typeof frame.seq === 'number') {
          session.appliedInputSeqs.add(frame.seq)
          // Persisted cursor = max applied — the hello.resume handshake only (02 §3).
          session.outbox.setLastAppliedInputSeq(frame.seq)
        }
        return
      }
      case 'session.slash': {
        const session = this.requireSession(frame.sessionId)
        if (!session) return
        if (typeof frame.seq === 'number' && session.appliedInputSeqs.has(frame.seq)) return
        await session.adapter.send({
          kind: 'slash',
          eventId: frame.payload.eventId,
          command: frame.payload.command,
          args: frame.payload.args ?? null,
        })
        if (typeof frame.seq === 'number') {
          session.appliedInputSeqs.add(frame.seq)
          session.outbox.setLastAppliedInputSeq(frame.seq)
        }
        return
      }
      case 'session.interrupt': {
        const session = this.requireSession(frame.sessionId)
        if (!session) return
        await session.adapter.interrupt()
        return
      }
      case 'session.setModel': {
        const session = this.requireSession(frame.sessionId)
        if (!session) return
        await session.adapter.setModel(frame.payload.model)
        return
      }
      case 'session.setPermissionMode': {
        const session = this.requireSession(frame.sessionId)
        if (!session) return
        const mode = frame.payload.mode as PermissionMode
        if (mode === 'bypassPermissions' && !this.opts.config().allowBypassPermissions) {
          // Defense in depth (08 §3): the flag is settable only on this machine.
          this.opts.relay.sendError(
            RELAY_ERROR_CODES.runnerInternal,
            'bypassPermissions refused: enable it on the machine with `yasui-runner config set allow-bypass on`',
            { refused: 'bypassPermissions' },
            session.sessionId,
          )
          this.emitEvent(
            session,
            this.systemEvent('bypassPermissions refused by runner policy — enable with `yasui-runner config set allow-bypass on`'),
          )
          throw new Error('bypassPermissions refused by runner-local policy')
        }
        await session.adapter.setPermissionMode(mode)
        return
      }
      case 'permission.verdict': {
        const session = this.requireSession(frame.sessionId)
        if (!session) return
        session.adapter.permissionVerdict(frame.payload.toolUseId, {
          behavior: frame.payload.behavior,
          message: frame.payload.message,
          updatedInput: frame.payload.updatedInput,
          appliedSuggestions: frame.payload.appliedSuggestions,
        })
        return
      }
      case 'session.end': {
        const session = this.requireSession(frame.sessionId)
        if (!session) return
        await session.adapter.stop(frame.payload.reason)
        return
      }
      default:
        return
    }
  }

  private requireSession(sessionId: string | undefined): LiveSession | null {
    const session = sessionId ? this.sessions.get(sessionId) : undefined
    if (!session || session.ended) {
      this.opts.relay.sendError(
        RELAY_ERROR_CODES.relayUnknownSession,
        `no live session ${sessionId ?? '(missing sessionId)'} on this runner`,
        undefined,
        sessionId,
      )
      return null
    }
    return session
  }

  /* ---------- session.start (04 §8.3 validation chain) ---------- */

  private async handleSessionStart(frame: SessionStartFrame): Promise<void> {
    const sessionId = frame.sessionId
    const payload = frame.payload
    const config = this.opts.config()

    if (this.sessions.has(sessionId)) {
      this.opts.log.warn({ sessionId }, 'duplicate session.start for a live session — ignoring')
      return
    }
    if (this.draining) {
      this.opts.relay.sendError(
        RELAY_ERROR_CODES.runnerSessionLimit,
        'runner is draining for an update',
        { detail: 'updating' },
        sessionId,
      )
      return
    }
    if (this.activeCount() >= config.maxConcurrentSessions) {
      this.opts.relay.sendError(
        RELAY_ERROR_CODES.runnerSessionLimit,
        `maxConcurrentSessions (${config.maxConcurrentSessions}) reached`,
        undefined,
        sessionId,
      )
      return
    }

    // Path under a configured root + git repo.
    let projectReal: string
    try {
      projectReal = this.opts.git.confineProjectPath(payload.project.path)
    } catch (err) {
      const e = err as GitServiceError
      this.opts.relay.sendError(RELAY_ERROR_CODES.runnerProjectNotFound, e.message, undefined, sessionId)
      return
    }
    if (!fs.existsSync(path.join(projectReal, '.git'))) {
      this.opts.relay.sendError(
        RELAY_ERROR_CODES.runnerProjectNotFound,
        `not a git repository: ${payload.project.path}`,
        undefined,
        sessionId,
      )
      return
    }

    // Worktree (04 §8.3): create on demand via GitService, or resolve an existing one.
    let cwd = projectReal
    let worktreeName: string | null = null
    if (payload.worktree) {
      try {
        const wtPath = this.opts.git.worktreePathFor(projectReal, payload.worktree.name)
        // `create` is ensure-exists (02 §9) in BOTH directions: a session.start
        // redelivered after a crash between `git worktree add` and
        // session.started carries a NEW frame id (LRU dedupe never fires) and
        // the original create:true spec — re-running `git worktree add` would
        // fail and wedge the session in STARTING. Conversely, redelivery after
        // an API restart arrives as create:false (the control plane loses the
        // create flag across restarts — documented deviation) for a worktree
        // that may never have been created, so a missing path falls back to
        // creating it. The path guard keeps unvetted names (create path
        // validation normally happens in worktreeCreate → requireName) from
        // escaping `.yasui-worktrees/` via `..` segments.
        const wtExists =
          fs.existsSync(wtPath) && path.dirname(wtPath) === path.join(projectReal, '.yasui-worktrees')
        if (!wtExists) {
          // Base-branch passthrough (04 §10 argv: git worktree add <path> -b
          // yasui/<name> [<branch>]). Cast until the protocol's session.start
          // worktree `branch?` field lands; zod looseObject already carries it.
          const baseBranch = (payload.worktree as { branch?: string }).branch
          const created = await this.opts.git.worktreeCreate(projectReal, payload.worktree.name, baseBranch)
          cwd = created.worktree.path
        } else {
          cwd = wtPath
        }
        worktreeName = payload.worktree.name
      } catch (err) {
        const e = err instanceof GitServiceError ? err : new GitServiceError((err as Error).message)
        this.opts.relay.sendError(e.code, `worktree setup failed: ${e.message}`, { stderr: redact(e.stderr) }, sessionId)
        return
      }
    }

    // Harness adapter.
    const factory = this.opts.adapters[payload.harness]
    if (!factory) {
      this.opts.relay.sendError(
        RELAY_ERROR_CODES.runnerHarnessUnavailable,
        `harness not available on this runner: ${payload.harness}`,
        undefined,
        sessionId,
      )
      return
    }

    // Permission-mode floor (08 §3): bypass requires the runner-local flag.
    let permissionMode = payload.permissionMode as PermissionMode
    let bypassDowngraded = false
    if (permissionMode === 'bypassPermissions' && !config.allowBypassPermissions) {
      permissionMode = 'default'
      bypassDowngraded = true
    }

    const outbox = this.opts.outboxes.forSession(sessionId)
    const diffWatcher = new DiffWatcher({
      projectPath: cwd,
      git: this.opts.git,
      emit: (diff) => {
        const payload = this.opts.config().redactionEnabled ? redactDeep(diff) : diff
        this.opts.relay.sendDroppable(this.makeFrame('session.diff', payload, sessionId), 'diff')
      },
      onError: (err) => this.opts.log.debug({ sessionId, err: err.message }, 'diff watcher run failed'),
    })

    const adapter = factory()
    const session: LiveSession = {
      sessionId,
      adapter,
      outbox,
      diffWatcher,
      projectPath: projectReal,
      cwd,
      worktree: worktreeName,
      status: 'working',
      ended: false,
      appliedInputSeqs: new AppliedInputSeqs(),
      statsTimer: null,
      statsPending: null,
      statsLastSentAt: 0,
    }
    this.sessions.set(sessionId, session)
    registerSessionSecret(sessionId, payload.inference.authToken)

    await diffWatcher.start()

    let started
    try {
      started = await adapter.start({
        sessionId,
        projectPath: cwd,
        projectTrusted: config.trustedProjects.includes(projectReal),
        model: payload.model,
        contextWindowTokens: payload.contextWindowTokens,
        permissionMode,
        permissionTimeoutMinutes: payload.permissionTimeoutMinutes,
        systemPromptAppend: payload.systemPromptAppend,
        maxTurns: payload.maxTurns,
        maxBudgetUsd: payload.maxBudgetUsd,
        resumeHarnessSessionId: payload.resumeHarnessSessionId,
        inference: { baseUrl: payload.inference.baseUrl, authToken: payload.inference.authToken },
        paths: { claudeConfigDir: claudeConfigDir(), sessionLog: sessionLogPath(sessionId) },
      })
    } catch (err) {
      const message = redact((err as Error).message ?? 'harness failed to start')
      this.opts.log.error({ sessionId, err: message }, 'harness start failed')
      this.emitEvent(session, { id: eventId(), at: new Date().toISOString(), kind: 'error', text: `harness failed to start: ${message}`, final: true })
      this.emitDurable(session, 'session.status', { status: 'failed' })
      this.emitDurable(
        session,
        'session.ended',
        { reason: 'failed', resultSummary: null, errorText: `harness failed to start: ${message}` },
        { fsync: true },
      )
      session.ended = true
      session.diffWatcher.stop()
      unregisterSessionSecret(sessionId)
      this.sessions.delete(sessionId)
      return
    }

    let gitBranch = ''
    try {
      gitBranch = await this.opts.git.currentBranch(cwd)
    } catch {
      gitBranch = ''
    }

    this.emitDurable(session, 'session.started', {
      startId: frame.id,
      harnessSessionId: started.harnessSessionId,
      model: started.model,
      permissionMode: started.permissionMode,
      slashCommands: started.slashCommands,
      tools: started.tools,
      contextWindowTokens: started.contextWindowTokens,
      cwd,
      gitBranch,
      worktree: worktreeName,
    })

    if (bypassDowngraded) {
      this.emitEvent(
        session,
        this.systemEvent(
          'bypassPermissions is disabled on this runner — started in default mode (enable with `yasui-runner config set allow-bypass on`)',
        ),
      )
    }

    void this.consume(session)
  }

  /* ---------- adapter output pipeline ---------- */

  private async consume(session: LiveSession): Promise<void> {
    try {
      for await (const output of session.adapter.output()) {
        await this.handleAdapterOutput(session, output)
        if (session.ended) break
      }
      if (!session.ended) {
        // Iterator ended without an 'ended' output — treat as failure (04 §14).
        await this.finishSession(session, {
          type: 'ended',
          reason: 'failed',
          resultSummary: null,
          errorText: 'harness output ended unexpectedly',
        })
      }
    } catch (err) {
      const message = redact((err as Error).message ?? 'unknown harness error')
      this.opts.log.error({ sessionId: session.sessionId, err: message }, 'adapter output loop failed')
      if (!session.ended) {
        this.emitEvent(session, { id: eventId(), at: new Date().toISOString(), kind: 'error', text: message, final: true })
        await this.finishSession(session, { type: 'ended', reason: 'failed', resultSummary: null, errorText: message })
      }
    }
  }

  private async handleAdapterOutput(session: LiveSession, output: AdapterOutput): Promise<void> {
    switch (output.type) {
      case 'event': {
        this.emitEvent(session, output.event)
        // Natural backpressure: block the adapter iterator at outbox limits (02 §10).
        await session.outbox.waitForCapacity()
        return
      }
      case 'delta': {
        const delta = this.opts.config().redactionEnabled ? redactDelta(output.delta) : output.delta
        this.opts.relay.sendDroppable(this.makeFrame('delta', delta, session.sessionId), 'delta')
        return
      }
      case 'status': {
        session.status = output.status
        this.emitDurable(session, 'session.status', {
          status: output.status,
          ...(output.detail ? { detail: output.detail } : {}),
        })
        return
      }
      case 'stats': {
        this.sendStats(session, output.stats)
        return
      }
      case 'tool-finished': {
        session.diffWatcher.onToolFinished(output.toolName, output.mutating)
        return
      }
      case 'ended': {
        await this.finishSession(session, output)
        return
      }
    }
  }

  /** session.stats coalescing: ≤ 1 per 2 s, latest wins (02 §7). */
  private sendStats(session: LiveSession, stats: SessionStatsPayload): void {
    const now = Date.now()
    const sinceLast = now - session.statsLastSentAt
    if (sinceLast >= STATS_COALESCE_MS) {
      session.statsLastSentAt = now
      this.opts.relay.sendDroppable(this.makeFrame('session.stats', stats, session.sessionId), 'stats')
      return
    }
    session.statsPending = stats
    if (session.statsTimer) return
    session.statsTimer = setTimeout(() => {
      session.statsTimer = null
      if (session.statsPending && !session.ended) {
        session.statsLastSentAt = Date.now()
        this.opts.relay.sendDroppable(this.makeFrame('session.stats', session.statsPending, session.sessionId), 'stats')
        session.statsPending = null
      }
    }, STATS_COALESCE_MS - sinceLast)
    if (typeof session.statsTimer === 'object' && 'unref' in session.statsTimer) session.statsTimer.unref()
  }

  private async finishSession(
    session: LiveSession,
    ended: Extract<AdapterOutput, { type: 'ended' }>,
  ): Promise<void> {
    if (session.ended) return
    session.ended = true
    if (session.statsTimer) {
      clearTimeout(session.statsTimer)
      session.statsTimer = null
    }

    // Final non-debounced diff run before session.ended (04 §11).
    const finalDiff = await session.diffWatcher.runFinal()
    if (finalDiff) {
      const payload = this.opts.config().redactionEnabled ? redactDeep(finalDiff) : finalDiff
      this.opts.relay.sendDroppable(this.makeFrame('session.diff', payload, session.sessionId), 'diff')
    }
    session.diffWatcher.stop()

    // Drop the inference key from memory (04 §8.3).
    unregisterSessionSecret(session.sessionId)

    const errorText = ended.errorText ? redact(ended.errorText) : null
    this.emitDurable(
      session,
      'session.ended',
      { reason: ended.reason, resultSummary: ended.resultSummary, errorText },
      { fsync: true },
    )

    // Keep the outbox until fully acked (04 §8.3); the live session is done.
    this.sessions.delete(session.sessionId)
  }

  /* ---------- shutdown ---------- */

  /** Graceful drain (yasui-runner stop / SIGTERM): stop every adapter, wait ≤ deadline. */
  async stopAll(reason: 'shutdown' | 'user' | 'admin' = 'shutdown', deadlineMs = 15_000): Promise<void> {
    const live = [...this.sessions.values()].filter((s) => !s.ended)
    if (live.length === 0) return
    const stops = live.map(async (session) => {
      try {
        await session.adapter.stop(reason)
      } catch (err) {
        this.opts.log.warn({ sessionId: session.sessionId, err: (err as Error).message }, 'adapter stop failed')
        await this.finishSession(session, {
          type: 'ended',
          reason: 'interrupted',
          resultSummary: null,
          errorText: null,
        })
      }
    })
    await Promise.race([
      Promise.allSettled(stops),
      new Promise((resolve) => setTimeout(resolve, deadlineMs)),
    ])
    // Anything still live after the deadline is finalized as interrupted.
    for (const session of [...this.sessions.values()]) {
      if (!session.ended) {
        await this.finishSession(session, { type: 'ended', reason: 'interrupted', resultSummary: null, errorText: null })
      }
    }
  }
}
