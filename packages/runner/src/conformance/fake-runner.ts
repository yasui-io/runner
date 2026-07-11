/**
 * Fake runner — the relay/v1 conformance tool (07 §12).
 *
 * Speaks the REAL protocol against a real control plane: pairs via
 * `POST /relay/v1/pair`, dials the relay WS, handshakes, heartbeats, acks,
 * replays its outbox after reconnect — with NO Claude Code and NO inference.
 * Scenarios are deterministic scripts (25 ms per delta, 100 ms per tool step)
 * so e2e assertions are stable.
 *
 * Scenarios:
 *  - basic      echoes a 3-sentence assistant reply as deltas, one tool event, success
 *  - permission "touch protected" → permission.request; approve → tool runs;
 *               deny → assistant acknowledges; silent → server timeout denies
 *  - longform   ~2 000-token reply (coalescing + rollover); "flood" → 700 events
 *  - git        fixture diff summary; commit/push/discard mutate in-memory tree state
 *  - flaky      drops the WebSocket mid-stream once, reconnects, resumes from acked seq
 */

import os from 'node:os'
import WebSocket from 'ws'
import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  parseServerFrame,
  RELAY_LIMITS,
  type DeltaPayload,
  type GitRequestPayload,
  type GitResultPayload,
  type HelloAckPayload,
  type Project,
  type RelayFrame,
  type SessionDiffPayload,
  type SessionStartFrame,
  type SessionStatus,
  type ServerToRunnerFrame,
  type WireSessionEvent,
} from '@yasui.io/runner-protocol'
import { createId, eventId, frameId, opId } from '../util/ids.js'

export const SCENARIOS = ['basic', 'permission', 'longform', 'git', 'flaky'] as const
export type ScenarioName = (typeof SCENARIOS)[number]

export const DELTA_TICK_MS = 25
export const TOOL_STEP_MS = 100
const COALESCE_MS = 2_000

/* ---------- pairing (real POST /relay/v1/pair) ---------- */

export async function pairFakeRunner(
  apiUrl: string,
  code: string,
  name: string,
): Promise<{ runnerId: string; token: string }> {
  const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/relay/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      name,
      os: process.platform,
      arch: process.arch,
      kind: 'vps',
      version: '0.0.0-conform',
      harnesses: [{ harness: 'claude-code', version: '0.0.0-conform' }],
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    let detail = ''
    try {
      detail = JSON.stringify(await res.json())
    } catch {
      /* ignore */
    }
    throw new Error(`pairing failed: HTTP ${res.status} ${detail}`)
  }
  const body = (await res.json()) as { runnerId: string; token: string }
  if (!body.runnerId || !body.token) throw new Error('pairing response missing runnerId/token')
  return body
}

/* ---------- deterministic content ---------- */

const BASIC_SENTENCES = [
  'Looking at the request, the change is small and well-contained. ',
  'I inspected the failing module and the fix is a one-line import correction. ',
  'All checks pass locally — this is ready to review.',
]

const LONGFORM_SENTENCE =
  'The architecture keeps the transport layer separate from the session state so reconnects are cheap and lossless. '

function longformText(): string {
  // ≈ 2 000 tokens — enough to exercise coalescing, rollover and backfill.
  return Array.from({ length: 160 }, (_, i) => `(${i + 1}) ${LONGFORM_SENTENCE}`).join('')
}

const FIXTURE_PROJECTS: Array<Omit<Project, 'trusted'>> = [
  {
    path: '/home/conform/acme-api',
    name: 'acme-api',
    branch: 'main',
    dirty: false,
    remoteUrl: 'git@github.com:acme/api.git',
    lastCommitAt: '2026-07-05T21:10:00.000Z',
  },
  {
    path: '/home/conform/acme-web',
    name: 'acme-web',
    branch: 'main',
    dirty: true,
    remoteUrl: 'git@github.com:acme/web.git',
    lastCommitAt: '2026-07-04T09:00:00.000Z',
  },
]

interface FakeFileChange {
  path: string
  status: 'modified' | 'added' | 'deleted'
  additions: number
  deletions: number
}

/* ---------- fake runner ---------- */

export interface FakeRunnerOptions {
  relayUrl: string
  token: string
  scenario: ScenarioName
  name?: string
  log?: (message: string) => void
  /** Test knobs. */
  deltaTickMs?: number
  toolStepMs?: number
  backoffMs?: number
}

interface FakeSession {
  sessionId: string
  status: SessionStatus
  lastAppliedInputSeq: number
  /** Unacked durable frames, in order (in-memory outbox). */
  outbox: Map<string, RelayFrame>
  pendingPermission: {
    eventId: string
    toolUseId: string
    tool: string
    request: string
    input: Record<string, unknown>
    expiresAt: string
  } | null
  gitFiles: FakeFileChange[]
  commits: number
  ended: boolean
  busy: boolean
}

export class FakeRunner {
  private ws: WebSocket | null = null
  private stopped = false
  private helloAcked = false
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private readonly sessions = new Map<string, FakeSession>()
  private readonly appliedCommands = new Set<string>()
  private flakyDropDone = false
  private reconnects = 0
  private readonly log: (message: string) => void
  private readonly deltaTickMs: number
  private readonly toolStepMs: number
  private readonly backoffMs: number
  private connectedResolvers: Array<() => void> = []

  constructor(private readonly opts: FakeRunnerOptions) {
    this.log = opts.log ?? (() => undefined)
    this.deltaTickMs = opts.deltaTickMs ?? DELTA_TICK_MS
    this.toolStepMs = opts.toolStepMs ?? TOOL_STEP_MS
    this.backoffMs = opts.backoffMs ?? 1_000
  }

  get reconnectCount(): number {
    return this.reconnects
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    if (this.ws) {
      try {
        this.ws.close(1000, 'conform shutdown')
      } catch {
        /* ignore */
      }
      this.ws = null
    }
  }

  /** Resolves on the next hello.ack (test helper). */
  waitConnected(): Promise<void> {
    if (this.helloAcked) return Promise.resolve()
    return new Promise((resolve) => this.connectedResolvers.push(resolve))
  }

  /* ---------- connection ---------- */

  private connect(): void {
    if (this.stopped) return
    this.helloAcked = false
    const ws = new WebSocket(this.opts.relayUrl, {
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        'x-yasui-runner-version': '0.0.0-conform',
      },
      handshakeTimeout: 10_000,
    })
    this.ws = ws

    ws.on('open', () => {
      if (this.ws !== ws) return
      this.sendRaw({
        id: frameId(),
        type: 'hello',
        ts: new Date().toISOString(),
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          minProtocolVersion: MIN_PROTOCOL_VERSION,
          runnerVersion: '0.0.0-conform',
          host: {
            hostname: this.opts.name ?? `conform-${os.hostname().split('.')[0]}`,
            os: process.platform,
            arch: process.arch,
            kind: 'vps',
          },
          harnesses: [{ harness: 'claude-code', version: '0.0.0-conform', sdkVersion: '0.0.0-conform' }],
          caps: ['git', 'worktrees', 'delta-streaming'],
          maxConcurrentSessions: 4,
          resume: [...this.sessions.values()]
            .filter((s) => !s.ended || s.outbox.size > 0)
            .map((s) => ({
              sessionId: s.sessionId,
              lastAppliedInputSeq: s.lastAppliedInputSeq,
              bufferedEventFrames: s.outbox.size,
              status: s.status,
            })),
        },
      })
    })

    ws.on('message', (data) => {
      if (this.ws !== ws) return
      void this.onMessage(typeof data === 'string' ? data : data.toString())
    })

    ws.on('close', (code) => {
      if (this.ws !== ws) return
      this.ws = null
      this.helloAcked = false
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
      if (this.stopped) return
      if (code === 4003 || code === 4013) {
        this.log(`relay closed with ${code} — stopping`)
        this.stopped = true
        return
      }
      this.log(`disconnected (${code}) — reconnecting in ${this.backoffMs} ms`)
      setTimeout(() => this.connect(), this.backoffMs)
    })

    ws.on('error', (err) => {
      if (this.ws !== ws) return
      this.log(`ws error: ${err.message}`)
    })
  }

  private sendRaw(frame: RelayFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(frame))
  }

  private frame<T>(type: string, payload: T, sessionId?: string): RelayFrame<string, T> {
    return { id: frameId(), type, ...(sessionId ? { sessionId } : {}), ts: new Date().toISOString(), payload }
  }

  /* ---------- inbound ---------- */

  private async onMessage(raw: string): Promise<void> {
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      return
    }
    const parsed = parseServerFrame(json)
    if (!parsed.ok) return
    const frame = parsed.frame

    switch (frame.type) {
      case 'hello.ack':
        this.onHelloAck(frame.payload as HelloAckPayload)
        return
      case 'heartbeat.ack':
        return
      case 'event.ack': {
        for (const ack of (frame.payload as { acks: Array<{ frameId: string; sessionId: string }> }).acks) {
          this.sessions.get(ack.sessionId)?.outbox.delete(ack.frameId)
        }
        return
      }
      default:
        break
    }

    // Session command dedupe + cmd.ack (real protocol behavior).
    if (frame.sessionId) {
      if (this.appliedCommands.has(frame.id)) {
        this.sendRaw(this.frame('cmd.ack', { ids: [frame.id] }))
        return
      }
      this.appliedCommands.add(frame.id)
      this.sendRaw(this.frame('cmd.ack', { ids: [frame.id] }))
    }

    switch (frame.type) {
      case 'session.start':
        await this.onSessionStart(frame as SessionStartFrame)
        return
      case 'session.message': {
        const session = this.sessions.get(frame.sessionId as string)
        if (!session) return
        if (typeof frame.seq === 'number') {
          if (frame.seq <= session.lastAppliedInputSeq) return
          session.lastAppliedInputSeq = frame.seq
        }
        void this.runScenarioTurn(session, frame.payload.text)
        return
      }
      case 'session.slash': {
        const session = this.sessions.get(frame.sessionId as string)
        if (!session) return
        if (typeof frame.seq === 'number') {
          if (frame.seq <= session.lastAppliedInputSeq) return
          session.lastAppliedInputSeq = frame.seq
        }
        this.emitEvent(session, {
          id: eventId(),
          at: new Date().toISOString(),
          kind: 'system',
          variant: 'info',
          text: `/${frame.payload.command} acknowledged (conform)`,
          final: true,
        })
        return
      }
      case 'session.interrupt': {
        const session = this.sessions.get(frame.sessionId as string)
        if (!session || session.ended) return
        session.busy = false
        this.emitStatus(session, 'idle')
        return
      }
      case 'session.setModel': {
        const session = this.sessions.get(frame.sessionId as string)
        if (!session) return
        this.emitEvent(session, {
          id: eventId(),
          at: new Date().toISOString(),
          kind: 'system',
          variant: 'model-change',
          text: `model switched to ${frame.payload.model}`,
          final: true,
        })
        return
      }
      case 'session.setPermissionMode': {
        const session = this.sessions.get(frame.sessionId as string)
        if (!session) return
        this.emitEvent(session, {
          id: eventId(),
          at: new Date().toISOString(),
          kind: 'system',
          variant: 'info',
          text: `permission mode set to ${frame.payload.mode}`,
          final: true,
        })
        return
      }
      case 'permission.verdict': {
        const session = this.sessions.get(frame.sessionId as string)
        if (!session) return
        void this.onPermissionVerdict(session, frame.payload.toolUseId, frame.payload.behavior, frame.payload.message)
        return
      }
      case 'session.end': {
        const session = this.sessions.get(frame.sessionId as string)
        if (!session || session.ended) return
        await this.endSession(session, 'interrupted', null)
        return
      }
      case 'git.request': {
        const payload = frame.payload as GitRequestPayload
        const session = frame.sessionId ? this.sessions.get(frame.sessionId) : undefined
        this.sendRaw(this.frame('git.result', this.gitResult(payload, session), frame.sessionId))
        if (session && ['commit', 'discard'].includes(payload.op)) this.emitDiff(session)
        return
      }
      case 'project.scan': {
        this.sendProjectList((frame.payload as { opId: string }).opId)
        return
      }
      default:
        return
    }
  }

  private onHelloAck(payload: HelloAckPayload): void {
    this.helloAcked = true
    this.reconnects++
    this.log(`hello.ack from server (runner ${payload.runnerId})`)
    this.sendRaw(this.frame('runner.config', { allowBypassPermissions: false, redactionEnabled: true }))
    // Outbox replay in order (02 §9).
    for (const session of this.sessions.values()) {
      for (const buffered of session.outbox.values()) this.sendRaw(buffered)
    }
    this.sendProjectList()
    const interval = payload.heartbeatIntervalMs > 0 ? payload.heartbeatIntervalMs : RELAY_LIMITS.heartbeatIntervalMs
    this.heartbeatTimer = setInterval(() => {
      this.sendRaw(
        this.frame('heartbeat', {
          activeSessions: [...this.sessions.values()].filter((s) => !s.ended).length,
          load1: 0.42,
          freeMemMb: 4096,
        }),
      )
    }, interval)
    const resolvers = this.connectedResolvers
    this.connectedResolvers = []
    for (const resolve of resolvers) resolve()
  }

  /* ---------- emit helpers ---------- */

  private emitEvent(session: FakeSession, event: WireSessionEvent): void {
    const frame = this.frame('event', { event }, session.sessionId)
    session.outbox.set(frame.id, frame)
    this.sendRaw(frame)
  }

  private emitDelta(session: FakeSession, delta: DeltaPayload): void {
    // Deltas are droppable and never buffered while disconnected (02 §10).
    if (!this.helloAcked) return
    this.sendRaw(this.frame('delta', delta, session.sessionId))
  }

  private emitStatus(session: FakeSession, status: SessionStatus, detail?: string): void {
    session.status = status
    const frame = this.frame('session.status', { status, ...(detail ? { detail } : {}) }, session.sessionId)
    session.outbox.set(frame.id, frame)
    this.sendRaw(frame)
  }

  private emitStats(session: FakeSession, turns: number): void {
    this.sendRaw(
      this.frame(
        'session.stats',
        {
          tokensIn: 1200 * turns,
          tokensOut: 800 * turns,
          cacheReadTokens: 4000 * turns,
          contextUsedTokens: 2200 * turns,
          costUsd: 0.0042 * turns,
          turns,
        },
        session.sessionId,
      ),
    )
  }

  private emitDiff(session: FakeSession): void {
    const payload: SessionDiffPayload = {
      additions: session.gitFiles.reduce((sum, f) => sum + f.additions, 0),
      deletions: session.gitFiles.reduce((sum, f) => sum + f.deletions, 0),
      files: session.gitFiles.map((f) => ({ ...f, hunks: [] })),
    }
    this.sendRaw(this.frame('session.diff', payload, session.sessionId))
  }

  private sendProjectList(replyOpId?: string): void {
    this.sendRaw(
      this.frame('project.list', {
        opId: replyOpId ?? opId(),
        projects: FIXTURE_PROJECTS.map((p) => ({ ...p, trusted: false })),
      }),
    )
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /* ---------- session lifecycle ---------- */

  private async onSessionStart(frame: SessionStartFrame): Promise<void> {
    const sessionId = frame.sessionId
    if (this.sessions.has(sessionId)) return
    const session: FakeSession = {
      sessionId,
      status: 'idle',
      lastAppliedInputSeq: 0,
      outbox: new Map(),
      pendingPermission: null,
      gitFiles:
        this.opts.scenario === 'git'
          ? [
              { path: 'src/router.ts', status: 'modified', additions: 96, deletions: 30 },
              { path: 'src/router.test.ts', status: 'added', additions: 32, deletions: 11 },
            ]
          : [],
      commits: 0,
      ended: false,
      busy: false,
    }
    this.sessions.set(sessionId, session)

    const startedFrame = this.frame(
      'session.started',
      {
        startId: frame.id,
        harnessSessionId: createId('conform'),
        model: frame.payload.model,
        permissionMode: frame.payload.permissionMode,
        slashCommands: ['compact', 'clear', 'context', 'usage'],
        tools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Task'],
        contextWindowTokens: frame.payload.contextWindowTokens,
        cwd: frame.payload.project.path,
        gitBranch: 'main',
        worktree: frame.payload.worktree?.name ?? null,
      },
      sessionId,
    )
    session.outbox.set(startedFrame.id, startedFrame)
    this.sendRaw(startedFrame)

    this.emitEvent(session, {
      id: eventId(),
      at: new Date().toISOString(),
      kind: 'system',
      variant: 'connect',
      text: `conform runner · scenario ${this.opts.scenario} · ${frame.payload.project.path}`,
      final: true,
    })
    this.emitStatus(session, 'idle')
    if (this.opts.scenario === 'git') this.emitDiff(session)
  }

  private async endSession(session: FakeSession, reason: 'completed' | 'failed' | 'interrupted' | 'ended', summary: string | null): Promise<void> {
    session.ended = true
    this.emitStatus(session, reason === 'failed' ? 'failed' : 'completed')
    const frame = this.frame(
      'session.ended',
      { reason, resultSummary: summary, errorText: null },
      session.sessionId,
    )
    session.outbox.set(frame.id, frame)
    this.sendRaw(frame)
  }

  /* ---------- scripted turns ---------- */

  private async runScenarioTurn(session: FakeSession, text: string): Promise<void> {
    if (session.ended || session.busy) return
    session.busy = true
    try {
      switch (this.opts.scenario) {
        case 'basic':
          await this.turnBasic(session)
          break
        case 'permission':
          await this.turnPermission(session, text)
          break
        case 'longform':
          await this.turnLongform(session, text)
          break
        case 'git':
          await this.turnGit(session, text)
          break
        case 'flaky':
          await this.turnFlaky(session)
          break
      }
    } finally {
      session.busy = false
    }
  }

  /** Stream `text` as deltas (25 ms tick) with ≤2 s coalesced revisions + 16 KiB rollover. */
  private async streamAssistant(session: FakeSession, text: string, chunkSize = 24): Promise<void> {
    this.emitStatus(session, 'streaming')
    let evId = eventId()
    let startedAt = new Date().toISOString()
    let cumulative = ''
    let lastRevisionAt = Date.now()
    for (let i = 0; i < text.length; i += chunkSize) {
      if (session.ended) return
      const chunk = text.slice(i, i + chunkSize)
      this.emitDelta(session, { target: 'assistant', eventId: evId, offset: cumulative.length, text: chunk })
      cumulative += chunk

      if (Buffer.byteLength(cumulative) >= RELAY_LIMITS.eventRolloverBytes) {
        // Rollover: finalize and continue in a fresh event id (02 §6).
        this.emitEvent(session, { id: evId, at: startedAt, kind: 'assistant', text: cumulative, final: true })
        evId = eventId()
        startedAt = new Date().toISOString()
        cumulative = ''
        lastRevisionAt = Date.now()
      } else if (Date.now() - lastRevisionAt >= COALESCE_MS) {
        this.emitEvent(session, { id: evId, at: startedAt, kind: 'assistant', text: cumulative, streaming: true })
        lastRevisionAt = Date.now()
      }
      await this.sleep(this.deltaTickMs)

      // flaky: hard-drop the socket once, mid-stream (07 §12).
      if (this.opts.scenario === 'flaky' && !this.flakyDropDone && i > text.length / 2) {
        this.flakyDropDone = true
        this.log('flaky scenario: dropping the WebSocket mid-stream')
        this.ws?.terminate()
      }
    }
    if (cumulative.length > 0) {
      this.emitEvent(session, { id: evId, at: startedAt, kind: 'assistant', text: cumulative, final: true })
    }
  }

  private async runTool(
    session: FakeSession,
    name: string,
    summary: string,
    output: string,
    steps = 3,
  ): Promise<void> {
    this.emitStatus(session, 'working')
    const evId = eventId()
    const callId = createId('tc')
    const at = new Date().toISOString()
    this.emitEvent(session, {
      id: evId,
      at,
      kind: 'tool',
      call: { id: callId, name, summary, status: 'running' },
    })
    await this.sleep(this.toolStepMs * steps)
    this.emitEvent(session, {
      id: evId,
      at,
      kind: 'tool',
      call: { id: callId, name, summary, status: 'success', durationMs: this.toolStepMs * steps, output },
      final: true,
    })
  }

  private async turnBasic(session: FakeSession): Promise<void> {
    this.emitStatus(session, 'working')
    await this.streamAssistant(session, BASIC_SENTENCES.join(''))
    await this.runTool(session, 'Read', 'Read src/router.ts', 'export const router = new Hono()')
    this.emitStats(session, 1)
    this.emitStatus(session, 'idle')
  }

  private async turnPermission(session: FakeSession, text: string): Promise<void> {
    if (!text.toLowerCase().includes('touch protected')) {
      await this.turnBasic(session)
      return
    }
    const permEventId = eventId()
    const toolUseId = createId('toolu')
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()
    session.pendingPermission = {
      eventId: permEventId,
      toolUseId,
      tool: 'Write',
      request: 'Write protected/config.yaml',
      input: { file_path: 'protected/config.yaml', content: 'safe: true' },
      expiresAt,
    }
    this.emitEvent(session, {
      id: permEventId,
      at: new Date().toISOString(),
      kind: 'permission',
      tool: 'Write',
      request: 'Write protected/config.yaml',
      status: 'pending',
      toolUseId,
      input: session.pendingPermission.input,
      expiresAt,
    })
    this.emitStatus(session, 'awaiting-permission')
    // No timer here on purpose: the silent case relies on the SERVER timeout (07 §12).
  }

  private async onPermissionVerdict(
    session: FakeSession,
    toolUseId: string,
    behavior: 'allow' | 'deny',
    message: string | null,
  ): Promise<void> {
    const pending = session.pendingPermission
    if (!pending || pending.toolUseId !== toolUseId) return
    session.pendingPermission = null
    this.emitEvent(session, {
      id: pending.eventId,
      at: new Date().toISOString(),
      kind: 'permission',
      tool: pending.tool,
      request: pending.request,
      status: behavior === 'allow' ? 'approved' : 'denied',
      toolUseId,
      input: pending.input,
      expiresAt: pending.expiresAt,
      final: true,
    })
    if (behavior === 'allow') {
      await this.runTool(session, pending.tool, pending.request, 'wrote protected/config.yaml')
      await this.streamAssistant(session, 'Done — the protected file was updated as approved.')
    } else {
      await this.streamAssistant(
        session,
        `Understood, I will not touch the protected file${message ? ` (${message})` : ''}.`,
      )
    }
    this.emitStatus(session, 'idle')
  }

  private async turnLongform(session: FakeSession, text: string): Promise<void> {
    if (text.toLowerCase().includes('flood')) {
      this.emitStatus(session, 'working')
      for (let i = 0; i < 700; i++) {
        this.emitEvent(session, {
          id: eventId(),
          at: new Date().toISOString(),
          kind: 'assistant',
          text: `flood event ${i + 1} of 700`,
          final: true,
        })
        if (i % 50 === 49) await this.sleep(this.deltaTickMs)
      }
      this.emitStatus(session, 'idle')
      return
    }
    this.emitStatus(session, 'working')
    await this.streamAssistant(session, longformText(), 160)
    this.emitStats(session, 2)
    this.emitStatus(session, 'idle')
  }

  private async turnGit(session: FakeSession, text: string): Promise<void> {
    this.emitStatus(session, 'working')
    await this.runTool(session, 'Edit', 'Edit src/router.ts', 'applied edit')
    // Every message mutates the fake tree a little.
    const existing = session.gitFiles.find((f) => f.path === 'src/router.ts')
    if (existing) existing.additions += 4
    else session.gitFiles.push({ path: 'src/router.ts', status: 'modified', additions: 4, deletions: 0 })
    this.emitDiff(session)
    await this.streamAssistant(session, `Adjusted the router per "${text.slice(0, 48)}" — diff updated.`)
    this.emitStatus(session, 'idle')
  }

  private async turnFlaky(session: FakeSession): Promise<void> {
    this.emitStatus(session, 'working')
    await this.streamAssistant(session, BASIC_SENTENCES.join('') + ' ' + LONGFORM_SENTENCE.repeat(20))
    await this.runTool(session, 'Read', 'Read src/index.ts', 'ok')
    this.emitStats(session, 1)
    this.emitStatus(session, 'idle')
  }

  /* ---------- fake git RPC state ---------- */

  private gitResult(payload: GitRequestPayload, session: FakeSession | undefined): GitResultPayload {
    const files = session?.gitFiles ?? []
    switch (payload.op) {
      case 'status':
        return {
          opId: payload.opId,
          op: 'status',
          ok: true,
          result: {
            branch: 'main',
            upstream: 'origin/main',
            dirty: files.length > 0,
            ahead: session?.commits ?? 0,
            behind: 0,
            staged: [],
            unstaged: files.filter((f) => f.status !== 'added').map((f) => f.path),
            untracked: files.filter((f) => f.status === 'added').map((f) => f.path),
          },
        }
      case 'diff':
        return {
          opId: payload.opId,
          op: 'diff',
          ok: true,
          result: {
            additions: files.reduce((sum, f) => sum + f.additions, 0),
            deletions: files.reduce((sum, f) => sum + f.deletions, 0),
            files: files.map((f) => ({ ...f, hunks: [] })),
          },
        }
      case 'diff.file': {
        const file = files.find((f) => f.path === payload.args.file)
        if (!file) {
          return {
            opId: payload.opId,
            op: 'diff.file',
            ok: false,
            error: { code: 'yasui_runner_git_failed', message: `no changes in ${payload.args.file}` },
          }
        }
        return {
          opId: payload.opId,
          op: 'diff.file',
          ok: true,
          result: {
            path: file.path,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            hunks: [
              {
                header: '@@ -12,6 +12,9 @@',
                lines: [
                  { kind: 'ctx', text: "import { Hono } from 'hono'" },
                  { kind: 'add', text: "import { z } from 'zod'" },
                  { kind: 'add', text: 'const schema = z.object({})' },
                ],
              },
            ],
          },
        }
      }
      case 'commit': {
        if (session) {
          session.commits++
          session.gitFiles = []
        }
        return {
          opId: payload.opId,
          op: 'commit',
          ok: true,
          result: {
            sha: `c0nf0rm${String(session?.commits ?? 1).padStart(3, '0')}${'0'.repeat(29)}`,
            branch: 'main',
            filesCommitted: files.length,
          },
        }
      }
      case 'push':
        return {
          opId: payload.opId,
          op: 'push',
          ok: true,
          result: {
            remote: payload.args.remote ?? 'origin',
            branch: 'main',
            url: 'https://github.com/acme/api/tree/main',
          },
        }
      case 'discard': {
        const discarded = files.map((f) => f.path)
        if (session) session.gitFiles = []
        return { opId: payload.opId, op: 'discard', ok: true, result: { discarded } }
      }
      case 'worktree.list':
        return {
          opId: payload.opId,
          op: 'worktree.list',
          ok: true,
          result: {
            worktrees: [{ name: 'acme-api', branch: 'main', path: '/home/conform/acme-api', dirty: files.length > 0, current: true }],
          },
        }
      case 'worktree.create':
        return {
          opId: payload.opId,
          op: 'worktree.create',
          ok: true,
          result: {
            worktree: {
              name: payload.args.name,
              branch: `yasui/${payload.args.name}`,
              path: `/home/conform/acme-api/.yasui-worktrees/${payload.args.name}`,
              dirty: false,
              current: false,
            },
          },
        }
      case 'worktree.remove':
        return { opId: payload.opId, op: 'worktree.remove', ok: true, result: { removed: true } }
    }
  }
}
