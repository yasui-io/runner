import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { HarnessId, PermissionMode, RelayFrame, SessionStartFrame } from '@yasui.io/runner-protocol'
import { OutboxManager } from '../src/daemon/outbox.js'
import { GitService, type GitExec } from '../src/git/git-service.js'
import { createLogger } from '../src/log/logger.js'
import type { AdapterOutput, HarnessAdapter, HarnessSessionConfig, HarnessStarted, PermissionVerdict } from '../src/sessions/harness-adapter.js'
import { SessionManager, type RelayLink } from '../src/sessions/session-manager.js'
import type { RunnerConfig } from '../src/config/config.js'

const log = createLogger({ level: 'silent' })

let root: string
let repo: string
let outboxDir: string

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yasui-sm-'))
  repo = path.join(root, 'proj')
  fs.mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo })
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hi')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
  repo = fs.realpathSync(repo)
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/* ---------- fakes ---------- */

class FakeAdapter implements HarnessAdapter {
  readonly harness: HarnessId = 'claude-code'
  config: HarnessSessionConfig | null = null
  sent: unknown[] = []
  interrupted = 0
  verdicts: Array<{ toolUseId: string; verdict: PermissionVerdict }> = []
  private queue: AdapterOutput[] = []
  private waiters: Array<() => void> = []
  private closed = false
  startError: Error | null = null

  async start(config: HarnessSessionConfig): Promise<HarnessStarted> {
    if (this.startError) throw this.startError
    this.config = config
    return {
      harnessSessionId: 'hs_fake',
      model: config.model,
      permissionMode: config.permissionMode,
      slashCommands: ['compact'],
      tools: ['Bash', 'Task'],
      contextWindowTokens: config.contextWindowTokens,
    }
  }

  push(output: AdapterOutput): void {
    this.queue.push(output)
    const w = this.waiters.shift()
    if (w) w()
  }

  async send(input: unknown): Promise<void> {
    this.sent.push(input)
  }

  async interrupt(): Promise<void> {
    this.interrupted++
  }

  permissionVerdict(toolUseId: string, verdict: PermissionVerdict): void {
    this.verdicts.push({ toolUseId, verdict })
  }

  async setModel(): Promise<void> {}
  async setPermissionMode(_mode: PermissionMode): Promise<void> {}

  async stop(): Promise<void> {
    this.push({ type: 'ended', reason: 'interrupted', resultSummary: null, errorText: null })
  }

  async *output(): AsyncIterable<AdapterOutput> {
    while (!this.closed) {
      if (this.queue.length === 0) {
        await new Promise<void>((resolve) => this.waiters.push(resolve))
        continue
      }
      const item = this.queue.shift() as AdapterOutput
      yield item
      if (item.type === 'ended') return
    }
  }
}

interface Ctx {
  manager: SessionManager
  adapter: FakeAdapter
  sent: RelayFrame[]
  errors: Array<{ code: string; message: string; details?: unknown; sessionId?: string }>
  config: RunnerConfig
  outboxes: OutboxManager
}

function makeCtx(configOverrides: Partial<RunnerConfig> = {}, gitExec?: GitExec): Ctx {
  outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yasui-sm-outbox-'))
  const sent: RelayFrame[] = []
  const errors: Array<{ code: string; message: string; details?: unknown; sessionId?: string }> = []
  const adapter = new FakeAdapter()
  const config: RunnerConfig = {
    version: 1,
    runnerId: 'run_t',
    token: 'yr_testtoken012345',
    relayUrl: 'ws://x',
    apiUrl: 'http://x',
    name: 't',
    kind: 'laptop',
    roots: [root],
    trustedProjects: [],
    allowBypassPermissions: false,
    redactionEnabled: true,
    maxConcurrentSessions: 2,
    logLevel: 'info',
    update: { auto: false, channel: 'latest' },
    ...configOverrides,
  }
  const relay: RelayLink = {
    connected: true,
    sendDurable: (frame) => {
      sent.push(frame)
      return true
    },
    sendDroppable: (frame) => {
      sent.push(frame)
      return true
    },
    sendError: (code, message, details, sessionId) => {
      errors.push({ code, message, details, ...(sessionId !== undefined ? { sessionId } : {}) })
    },
  }
  const outboxes = new OutboxManager(outboxDir)
  const manager = new SessionManager({
    config: () => config,
    git: new GitService({ roots: () => config.roots, ...(gitExec ? { exec: gitExec } : {}) }),
    outboxes,
    relay,
    adapters: { 'claude-code': () => adapter },
    log,
  })
  return { manager, adapter, sent, errors, config, outboxes }
}

function startFrame(sessionId = 'ags_t1', overrides: Record<string, unknown> = {}): SessionStartFrame {
  return {
    id: `cmd_start_${sessionId}`,
    type: 'session.start',
    sessionId,
    ts: new Date().toISOString(),
    payload: {
      harness: 'claude-code',
      project: { path: repo, projectId: 'prj_1' },
      worktree: null,
      model: 'claude-sonnet-4-5',
      contextWindowTokens: 200_000,
      permissionMode: 'default',
      permissionTimeoutMinutes: 15,
      systemPromptAppend: null,
      maxTurns: 80,
      maxBudgetUsd: 10,
      resumeHarnessSessionId: null,
      inference: {
        baseUrl: 'http://api',
        authToken: 'yk_live_agsn_secretkey123456',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
      ...overrides,
    },
  } as SessionStartFrame
}

const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
  fs.rmSync(outboxDir, { recursive: true, force: true })
})

describe('SessionManager session.start validation chain (04 §8.3)', () => {
  it('happy path: session.started with harness info + git branch', async () => {
    const ctx = makeCtx()
    await ctx.manager.handleCommand(startFrame())
    const started = ctx.sent.find((f) => f.type === 'session.started')
    expect(started).toBeDefined()
    const payload = started?.payload as { harnessSessionId: string; gitBranch: string; startId: string; tools: string[] }
    expect(payload.harnessSessionId).toBe('hs_fake')
    expect(payload.gitBranch).toBe('main')
    expect(payload.startId).toBe('cmd_start_ags_t1')
    expect(payload.tools).toContain('Task')
    expect(ctx.manager.activeCount()).toBe(1)
  })

  it('rejects paths outside roots with yasui_runner_project_not_found', async () => {
    const ctx = makeCtx()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'yasui-sm-outside-'))
    try {
      await ctx.manager.handleCommand(startFrame('ags_bad', { project: { path: outside, projectId: 'p' } }))
      expect(ctx.errors[0]?.code).toBe('yasui_runner_project_not_found')
      expect(ctx.manager.activeCount()).toBe(0)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects non-git directories', async () => {
    const ctx = makeCtx()
    const plainDir = path.join(root, 'not-a-repo')
    fs.mkdirSync(plainDir, { recursive: true })
    await ctx.manager.handleCommand(startFrame('ags_bad2', { project: { path: plainDir, projectId: 'p' } }))
    expect(ctx.errors[0]?.code).toBe('yasui_runner_project_not_found')
  })

  it('enforces maxConcurrentSessions', async () => {
    const ctx = makeCtx({ maxConcurrentSessions: 1 })
    await ctx.manager.handleCommand(startFrame('ags_one'))
    await ctx.manager.handleCommand(startFrame('ags_two'))
    expect(ctx.errors[0]?.code).toBe('yasui_runner_session_limit')
  })

  it('rejects unknown harnesses', async () => {
    const ctx = makeCtx()
    await ctx.manager.handleCommand(startFrame('ags_h', { harness: 'opencode' }))
    expect(ctx.errors[0]?.code).toBe('yasui_runner_harness_unavailable')
  })

  it('draining rejects with session_limit + detail updating (04 §12)', async () => {
    const ctx = makeCtx()
    ctx.manager.setDraining(true)
    await ctx.manager.handleCommand(startFrame('ags_d'))
    expect(ctx.errors[0]?.code).toBe('yasui_runner_session_limit')
    expect(ctx.errors[0]?.message).toContain('drain')
  })

  it('downgrades bypassPermissions when the runner flag is off (08 §3)', async () => {
    const ctx = makeCtx()
    await ctx.manager.handleCommand(startFrame('ags_byp', { permissionMode: 'bypassPermissions' }))
    expect(ctx.adapter.config?.permissionMode).toBe('default')
    const sysEvent = ctx.sent.find(
      (f) => f.type === 'event' && ((f.payload as { event: { kind: string } }).event.kind === 'system'),
    )
    expect(JSON.stringify(sysEvent?.payload)).toContain('bypassPermissions is disabled')
  })

  it('passes bypassPermissions through when the flag is on', async () => {
    const ctx = makeCtx({ allowBypassPermissions: true })
    await ctx.manager.handleCommand(startFrame('ags_byp2', { permissionMode: 'bypassPermissions' }))
    expect(ctx.adapter.config?.permissionMode).toBe('bypassPermissions')
  })

  it('worktree.create resolves the adapter cwd to the new worktree', async () => {
    const ctx = makeCtx()
    await ctx.manager.handleCommand(startFrame('ags_wt', { worktree: { create: true, name: 'wt-test' } }))
    expect(ctx.adapter.config?.projectPath).toBe(path.join(repo, '.yasui-worktrees', 'wt-test'))
    const started = ctx.sent.find((f) => f.type === 'session.started')
    expect((started?.payload as { worktree: string | null }).worktree).toBe('wt-test')
    // cleanup
    execFileSync('git', ['worktree', 'remove', '--force', path.join(repo, '.yasui-worktrees', 'wt-test')], { cwd: repo })
    execFileSync('git', ['branch', '-D', 'yasui/wt-test'], { cwd: repo })
  })

  it('redelivered session.start treats worktree.create as ensure-exists (02 §9)', async () => {
    const ctx1 = makeCtx()
    const outboxDir1 = outboxDir
    await ctx1.manager.handleCommand(startFrame('ags_wt_r', { worktree: { create: true, name: 'wt-redeliver' } }))
    expect(ctx1.sent.find((f) => f.type === 'session.started')).toBeDefined()

    // Runner "crashed" before session.started reached the server: the control
    // plane remints session.start with a NEW frame id and the original
    // create:true spec — the worktree path already exists on disk.
    const ctx2 = makeCtx()
    const reminted = startFrame('ags_wt_r', { worktree: { create: true, name: 'wt-redeliver' } })
    reminted.id = 'cmd_start_reminted'
    await ctx2.manager.handleCommand(reminted)
    try {
      expect(ctx2.errors).toHaveLength(0)
      expect(ctx2.sent.find((f) => f.type === 'session.started')).toBeDefined()
      expect(ctx2.adapter.config?.projectPath).toBe(path.join(repo, '.yasui-worktrees', 'wt-redeliver'))
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', path.join(repo, '.yasui-worktrees', 'wt-redeliver')], { cwd: repo })
      execFileSync('git', ['branch', '-D', 'yasui/wt-redeliver'], { cwd: repo })
      fs.rmSync(outboxDir1, { recursive: true, force: true })
    }
  })

  it('worktree create:false with a missing path falls back to creating it (API-restart redelivery)', async () => {
    // The control plane loses the original create flag across restarts
    // (documented deviation): redelivery arrives as { create: false, name }
    // for a worktree that was never created — must NOT fail with
    // yasui_runner_project_not_found.
    const ctx = makeCtx()
    const wtPath = path.join(repo, '.yasui-worktrees', 'wt-createfalse')
    await ctx.manager.handleCommand(startFrame('ags_wt_cf', { worktree: { create: false, name: 'wt-createfalse' } }))
    try {
      expect(ctx.errors).toHaveLength(0)
      expect(ctx.sent.find((f) => f.type === 'session.started')).toBeDefined()
      expect(ctx.adapter.config?.projectPath).toBe(wtPath)
      // session-scoped git.request routing resolves the LIVE session's cwd (worktree-aware)
      expect(ctx.manager.sessionGitPaths('ags_wt_cf')).toEqual({ projectPath: repo, cwd: wtPath })
      expect(ctx.manager.sessionGitPaths('ags_ghost')).toBeNull()
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: repo })
      execFileSync('git', ['branch', '-D', 'yasui/wt-createfalse'], { cwd: repo })
    }
  })

  it('worktree branch passthrough: new worktree starts from the requested base branch', async () => {
    const repo2 = path.join(root, 'proj-branch')
    fs.mkdirSync(repo2, { recursive: true })
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo2 })
    execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo2 })
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo2 })
    fs.writeFileSync(path.join(repo2, 'a.txt'), 'hi')
    execFileSync('git', ['add', '-A'], { cwd: repo2 })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo2 })
    execFileSync('git', ['checkout', '-b', 'wt-base'], { cwd: repo2 })
    fs.writeFileSync(path.join(repo2, 'base-only.txt'), 'base')
    execFileSync('git', ['add', '-A'], { cwd: repo2 })
    execFileSync('git', ['commit', '-m', 'base commit'], { cwd: repo2 })
    execFileSync('git', ['checkout', 'main'], { cwd: repo2 })
    const repo2Real = fs.realpathSync(repo2)
    try {
      const ctx = makeCtx()
      await ctx.manager.handleCommand(
        startFrame('ags_wt_br', {
          project: { path: repo2Real, projectId: 'prj_2' },
          worktree: { create: true, name: 'wtb', branch: 'wt-base' },
        }),
      )
      expect(ctx.errors).toHaveLength(0)
      const wtPath = path.join(repo2Real, '.yasui-worktrees', 'wtb')
      expect(ctx.adapter.config?.projectPath).toBe(wtPath)
      // yasui/wtb was cut from wt-base, not main
      expect(fs.existsSync(path.join(wtPath, 'base-only.txt'))).toBe(true)
    } finally {
      fs.rmSync(repo2, { recursive: true, force: true })
    }
  })

  it('worktree setup failure redacts stderr in error details (04 §13)', async () => {
    const token = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    const failingExec: GitExec = async () => ({
      stdout: '',
      stderr: `fatal: unable to access 'https://${token}@github.com/a/b.git'`,
      code: 128,
    })
    const ctx = makeCtx({}, failingExec)
    await ctx.manager.handleCommand(startFrame('ags_wt_err', { worktree: { create: true, name: 'wt-err' } }))
    const err = ctx.errors[0]
    expect(err?.code).toBe('yasui_runner_git_failed')
    const details = JSON.stringify(err?.details)
    expect(details).toContain('[redacted:github-token]')
    expect(details).not.toContain(token)
  })

  it('adapter start failure → error event + failed status + session.ended failed', async () => {
    const ctx = makeCtx()
    ctx.adapter.startError = new Error('boot exploded with token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')
    await ctx.manager.handleCommand(startFrame('ags_fail'))
    const ended = ctx.sent.find((f) => f.type === 'session.ended')
    const payload = ended?.payload as { reason: string; errorText: string }
    expect(payload.reason).toBe('failed')
    expect(payload.errorText).toContain('[redacted:github-token]') // redaction on error text
    expect(ctx.manager.activeCount()).toBe(0)
  })
})

describe('SessionManager adapter pipeline', () => {
  it('events flow through redaction into the outbox and relay', async () => {
    const ctx = makeCtx()
    await ctx.manager.handleCommand(startFrame('ags_pipe'))
    ctx.adapter.push({
      type: 'event',
      event: {
        id: 'ev_tool1',
        at: new Date().toISOString(),
        kind: 'tool',
        call: { id: 'tc1', name: 'Bash', summary: 'echo', status: 'success', output: 'key yk_live_agsn_secretkey123456' },
        final: true,
      },
    })
    await flush()
    const eventFrame = ctx.sent.find((f) => f.type === 'event' && JSON.stringify(f.payload).includes('ev_tool1'))
    expect(eventFrame).toBeDefined()
    // session-key exact match (registered at start) fires before the yasui-key pattern
    expect(JSON.stringify(eventFrame?.payload)).toContain('[redacted:session-key]')
  })

  it('input seq tracking: duplicate seqs are dropped, lastAppliedInputSeq persists', async () => {
    const ctx = makeCtx()
    await ctx.manager.handleCommand(startFrame('ags_seq'))
    const msg = (seq: number) =>
      ({
        id: `cmd_m_${seq}`,
        type: 'session.message',
        sessionId: 'ags_seq',
        seq,
        ts: new Date().toISOString(),
        payload: { eventId: `ev_u${seq}`, text: `msg ${seq}` },
      }) as never
    await ctx.manager.handleCommand(msg(515))
    await ctx.manager.handleCommand(msg(515)) // duplicate
    await ctx.manager.handleCommand(msg(516))
    expect(ctx.adapter.sent).toHaveLength(2)
    const entries = ctx.manager.resumeEntries()
    expect(entries.find((e) => e.sessionId === 'ags_seq')?.lastAppliedInputSeq).toBe(516)
  })

  it('input seq dedupe is by exact seq: a redelivered seq losing the race to seq+1 still applies', async () => {
    const ctx = makeCtx()
    await ctx.manager.handleCommand(startFrame('ags_seqrace'))
    const msg = (seq: number, id: string) =>
      ({
        id,
        type: 'session.message',
        sessionId: 'ags_seqrace',
        seq,
        ts: new Date().toISOString(),
        payload: { eventId: `ev_u${seq}`, text: `msg ${seq}` },
      }) as never
    // Right after reconnect: fresh REST seq 11 wins the race against redelivered seq 10.
    await ctx.manager.handleCommand(msg(11, 'cmd_fresh_11'))
    await ctx.manager.handleCommand(msg(10, 'cmd_redelivered_10')) // must NOT be skipped
    await ctx.manager.handleCommand(msg(10, 'cmd_redelivered_10_again')) // exact dup — dropped
    expect((ctx.adapter.sent as Array<{ text: string }>).map((m) => m.text)).toEqual(['msg 11', 'msg 10'])
    // Resume cursor stays at the max applied seq.
    expect(ctx.manager.resumeEntries().find((e) => e.sessionId === 'ags_seqrace')?.lastAppliedInputSeq).toBe(11)
  })

  it('permission verdict routes to the adapter', async () => {
    const ctx = makeCtx()
    await ctx.manager.handleCommand(startFrame('ags_perm'))
    await ctx.manager.handleCommand({
      id: 'cmd_p1',
      type: 'permission.verdict',
      sessionId: 'ags_perm',
      ts: new Date().toISOString(),
      payload: {
        permissionEventId: 'ev_pm1',
        toolUseId: 'toolu_1',
        behavior: 'allow',
        message: null,
        updatedInput: null,
        appliedSuggestions: [],
      },
    } as never)
    expect(ctx.adapter.verdicts[0]?.toolUseId).toBe('toolu_1')
    expect(ctx.adapter.verdicts[0]?.verdict.behavior).toBe('allow')
  })

  it('setPermissionMode bypass is refused without the runner flag (defense in depth)', async () => {
    const ctx = makeCtx()
    await ctx.manager.handleCommand(startFrame('ags_pm'))
    await expect(
      ctx.manager.handleCommand({
        id: 'cmd_pm1',
        type: 'session.setPermissionMode',
        sessionId: 'ags_pm',
        ts: new Date().toISOString(),
        payload: { mode: 'bypassPermissions' },
      } as never),
    ).rejects.toThrow('bypassPermissions refused by runner-local policy')
    expect(ctx.errors.some((e) => e.message.includes('bypassPermissions refused'))).toBe(true)
  })

  it('commands for unknown sessions produce yasui_relay_unknown_session', async () => {
    const ctx = makeCtx()
    await ctx.manager.handleCommand({
      id: 'cmd_x',
      type: 'session.interrupt',
      sessionId: 'ags_ghost',
      ts: new Date().toISOString(),
      payload: {},
    } as never)
    expect(ctx.errors[0]?.code).toBe('yasui_relay_unknown_session')
  })

  it('ended output → final diff + session.ended + secret dropped + session removed', async () => {
    const ctx = makeCtx()
    await ctx.manager.handleCommand(startFrame('ags_end'))
    ctx.adapter.push({ type: 'status', status: 'working' })
    ctx.adapter.push({ type: 'ended', reason: 'completed', resultSummary: 'done', errorText: null })
    await flush(80)
    const ended = ctx.sent.find((f) => f.type === 'session.ended')
    expect((ended?.payload as { reason: string }).reason).toBe('completed')
    expect(ctx.manager.activeCount()).toBe(0)
    // outbox retained until acked
    expect(ctx.outboxes.all().some((o) => o.sessionId === 'ags_end' && o.depth > 0)).toBe(true)
    // acking everything drops the outbox
    const sessionFrames = ctx.sent.filter((f) => f.sessionId === 'ags_end' && ['event', 'session.started', 'session.status', 'session.ended'].includes(f.type))
    ctx.manager.handleEventAck(sessionFrames.map((f) => ({ frameId: f.id, sessionId: 'ags_end' })))
    expect(ctx.outboxes.all().some((o) => o.sessionId === 'ags_end')).toBe(false)
  })

  it('hello.ack resume state unknown → kills the session and discards the outbox', async () => {
    const ctx = makeCtx()
    await ctx.manager.handleCommand(startFrame('ags_unknown'))
    expect(ctx.manager.activeCount()).toBe(1)
    await ctx.manager.onHelloAck({
      protocolVersion: 1,
      runnerId: 'run_t',
      heartbeatIntervalMs: 20_000,
      limits: { maxFrameBytes: 1, maxToolOutputBytes: 1, maxEventBytes: 1, deltaFlushMs: 1 },
      resume: [{ sessionId: 'ags_unknown', lastPersistedSeq: 0, state: 'unknown' }],
      serverTime: new Date().toISOString(),
    })
    await flush()
    expect(ctx.manager.activeCount()).toBe(0)
  })
})
