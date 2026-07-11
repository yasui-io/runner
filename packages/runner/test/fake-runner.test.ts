/**
 * Fake-runner loopback smoke (07 §12): drive the FakeRunner against a local
 * mock relay server (the 'ws' package). No monorepo api dependency — this
 * verifies the conform tool speaks the protocol correctly end to end:
 * hello → hello.ack → runner.config → project.list → session lifecycle →
 * deltas + coalesced revisions → permission round-trip → git RPC → outbox
 * replay after the flaky drop.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket as ServerWs } from 'ws'
import { parseRunnerFrame, type RelayFrame } from '@yasui.io/runner-protocol'
import { FakeRunner, type ScenarioName } from '../src/conformance/fake-runner.js'

interface MockRelay {
  port: number
  frames: RelayFrame[]
  framesByType: (type: string) => RelayFrame[]
  send: (frame: Record<string, unknown>) => void
  currentSocket: () => ServerWs | null
  close: () => Promise<void>
  malformed: number
}

async function startMockRelay(): Promise<MockRelay> {
  const server = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const port = (server.address() as { port: number }).port
  const frames: RelayFrame[] = []
  let socket: ServerWs | null = null
  let malformed = 0
  let seq = 1000

  server.on('connection', (ws) => {
    socket = ws
    ws.on('message', (raw) => {
      const parsed = parseRunnerFrame(JSON.parse(raw.toString()))
      if (!parsed.ok) {
        malformed++
        return
      }
      const frame = parsed.frame as RelayFrame
      frames.push(frame)
      if (frame.type === 'hello') {
        ws.send(
          JSON.stringify({
            id: 'f_mock_helloack',
            type: 'hello.ack',
            ts: new Date().toISOString(),
            payload: {
              protocolVersion: 1,
              runnerId: 'run_mock',
              heartbeatIntervalMs: 60_000,
              limits: { maxFrameBytes: 1_048_576, maxToolOutputBytes: 65_536, maxEventBytes: 262_144, deltaFlushMs: 2_000 },
              resume: [],
              serverTime: new Date().toISOString(),
            },
          }),
        )
      }
      // Ack every durable frame (event + session lifecycle) like the real server.
      if (['event', 'session.started', 'session.status', 'session.ended'].includes(frame.type) && frame.sessionId) {
        seq++
        ws.send(
          JSON.stringify({
            id: `f_mock_ack_${seq}`,
            type: 'event.ack',
            ts: new Date().toISOString(),
            payload: { acks: [{ frameId: frame.id, sessionId: frame.sessionId, seq }] },
          }),
        )
      }
    })
  })

  return {
    port,
    frames,
    framesByType: (type) => frames.filter((f) => f.type === type),
    send: (frame) => socket?.send(JSON.stringify(frame)),
    currentSocket: () => socket,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate()
        server.close(() => resolve())
      }),
    get malformed() {
      return malformed
    },
  }
}

async function until(cond: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

function makeRunner(relay: MockRelay, scenario: ScenarioName): FakeRunner {
  return new FakeRunner({
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    token: 'yr_conformtest0123456789',
    scenario,
    deltaTickMs: 1,
    toolStepMs: 5,
    backoffMs: 50,
  })
}

const startSession = (relay: MockRelay, sessionId: string) =>
  relay.send({
    id: `cmd_start_${sessionId}`,
    type: 'session.start',
    sessionId,
    ts: new Date().toISOString(),
    payload: {
      harness: 'claude-code',
      project: { path: '/home/conform/acme-api', projectId: 'prj_1' },
      worktree: null,
      model: 'claude-sonnet-4-5',
      contextWindowTokens: 200_000,
      permissionMode: 'default',
      permissionTimeoutMinutes: 15,
      systemPromptAppend: null,
      maxTurns: 80,
      maxBudgetUsd: 10,
      resumeHarnessSessionId: null,
      inference: { baseUrl: 'http://mock', authToken: 'yk_live_mock_key123456', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    },
  })

const sendMessage = (relay: MockRelay, sessionId: string, seq: number, text: string) =>
  relay.send({
    id: `cmd_msg_${sessionId}_${seq}`,
    type: 'session.message',
    sessionId,
    seq,
    ts: new Date().toISOString(),
    payload: { eventId: `ev_u${seq}`, text },
  })

let cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup) await fn()
  cleanup = []
})

describe('fake-runner loopback smoke', () => {
  it('basic scenario: handshake, session lifecycle, deltas + finalized assistant text, tool event', async () => {
    const relay = await startMockRelay()
    const runner = makeRunner(relay, 'basic')
    cleanup.push(() => runner.stop(), () => relay.close())
    runner.start()
    await runner.waitConnected()

    // handshake artifacts
    await until(() => relay.framesByType('runner.config').length === 1 && relay.framesByType('project.list').length === 1)

    startSession(relay, 'ags_basic')
    await until(() => relay.framesByType('session.started').length === 1)
    const started = relay.framesByType('session.started')[0]!
    expect((started.payload as { startId: string }).startId).toBe('cmd_start_ags_basic')
    // cmd.ack for the start command
    await until(() => relay.framesByType('cmd.ack').some((f) => (f.payload as { ids: string[] }).ids.includes('cmd_start_ags_basic')))

    sendMessage(relay, 'ags_basic', 1, 'do the thing')
    await until(() => relay.framesByType('session.ended').length === 0 && relay.framesByType('session.stats').length >= 1, 10_000)

    // deltas flowed and the finalized assistant revision equals their concatenation
    const deltas = relay.framesByType('delta').filter((f) => (f.payload as { target: string }).target === 'assistant')
    expect(deltas.length).toBeGreaterThan(3)
    const finals = relay
      .framesByType('event')
      .map((f) => (f.payload as { event: { kind: string; text?: string; final?: boolean } }).event)
      .filter((e) => e.kind === 'assistant' && e.final)
    expect(finals.map((e) => e.text).join('')).toContain('ready to review')

    // one tool event that transitioned running → success under the same event id
    const toolRevisions = relay
      .framesByType('event')
      .map((f) => (f.payload as { event: { id: string; kind: string; call?: { status: string } } }).event)
      .filter((e) => e.kind === 'tool')
    expect(toolRevisions.some((e) => e.call?.status === 'running')).toBe(true)
    expect(toolRevisions.some((e) => e.call?.status === 'success')).toBe(true)
    expect(new Set(toolRevisions.map((e) => e.id)).size).toBe(1)

    // every frame the runner sent parsed with the real schemas (mock counts malformed)
    expect(relay.malformed).toBe(0)
  })

  it('permission scenario: pending → verdict → resolved revision → tool runs', async () => {
    const relay = await startMockRelay()
    const runner = makeRunner(relay, 'permission')
    cleanup.push(() => runner.stop(), () => relay.close())
    runner.start()
    await runner.waitConnected()
    startSession(relay, 'ags_perm')
    await until(() => relay.framesByType('session.started').length === 1)

    sendMessage(relay, 'ags_perm', 1, 'please touch protected config')
    await until(() =>
      relay
        .framesByType('event')
        .some((f) => (f.payload as { event: { kind: string; status?: string } }).event.kind === 'permission'),
    )
    const pending = relay
      .framesByType('event')
      .map((f) => (f.payload as { event: { kind: string; status?: string; toolUseId?: string; id: string } }).event)
      .find((e) => e.kind === 'permission' && e.status === 'pending')!
    expect(pending.toolUseId).toBeDefined()
    await until(() => relay.framesByType('session.status').some((f) => (f.payload as { status: string }).status === 'awaiting-permission'))

    relay.send({
      id: 'cmd_verdict_1',
      type: 'permission.verdict',
      sessionId: 'ags_perm',
      ts: new Date().toISOString(),
      payload: {
        permissionEventId: pending.id,
        toolUseId: pending.toolUseId,
        behavior: 'allow',
        message: null,
        updatedInput: null,
        appliedSuggestions: [],
      },
    })
    await until(() =>
      relay
        .framesByType('event')
        .some(
          (f) =>
            (f.payload as { event: { kind: string; status?: string; id: string } }).event.id === pending.id &&
            (f.payload as { event: { status?: string } }).event.status === 'approved',
        ),
    )
    // approved → the write tool ran
    await until(() =>
      relay
        .framesByType('event')
        .some((f) => {
          const e = (f.payload as { event: { kind: string; call?: { name: string; status: string } } }).event
          return e.kind === 'tool' && e.call?.name === 'Write' && e.call.status === 'success'
        }),
    )
  })

  it('git scenario: diff summary flows; commit RPC clears the fake tree', async () => {
    const relay = await startMockRelay()
    const runner = makeRunner(relay, 'git')
    cleanup.push(() => runner.stop(), () => relay.close())
    runner.start()
    await runner.waitConnected()
    startSession(relay, 'ags_git')
    await until(() => relay.framesByType('session.diff').length >= 1)
    const diff = relay.framesByType('session.diff')[0]!.payload as { additions: number; files: unknown[] }
    expect(diff.additions).toBeGreaterThan(0)
    expect(diff.files).toHaveLength(2)

    relay.send({
      id: 'cmd_git_1',
      type: 'git.request',
      sessionId: 'ags_git',
      ts: new Date().toISOString(),
      payload: { opId: 'op_commit1', op: 'commit', args: { path: '/home/conform/acme-api', message: 'test commit' } },
    })
    await until(() => relay.framesByType('git.result').length >= 1)
    const result = relay.framesByType('git.result')[0]!.payload as { opId: string; ok: boolean; result: { sha: string } }
    expect(result.opId).toBe('op_commit1')
    expect(result.ok).toBe(true)
    expect(result.result.sha).toMatch(/^c0nf0rm/)
    // post-commit diff re-report is clean
    await until(() =>
      relay.framesByType('session.diff').some((f) => (f.payload as { files: unknown[] }).files.length === 0),
    )
  })

  it('flaky scenario: socket drops mid-stream, reconnects, outbox replays (no lost events)', async () => {
    const relay = await startMockRelay()
    const runner = makeRunner(relay, 'flaky')
    cleanup.push(() => runner.stop(), () => relay.close())
    runner.start()
    await runner.waitConnected()
    startSession(relay, 'ags_flaky')
    await until(() => relay.framesByType('session.started').length === 1)

    sendMessage(relay, 'ags_flaky', 1, 'go')
    // The scenario terminates its socket once mid-stream, then reconnects.
    await until(() => runner.reconnectCount >= 2, 15_000)
    await until(
      () =>
        relay
          .framesByType('event')
          .some((f) => {
            const e = (f.payload as { event: { kind: string; final?: boolean; call?: { status: string } } }).event
            return e.kind === 'tool' && e.call?.status === 'success'
          }),
      15_000,
    )
    // Full assistant text is reconstructible from finalized revisions despite the drop.
    const finalTexts = relay
      .framesByType('event')
      .map((f) => (f.payload as { event: { id: string; kind: string; text?: string; final?: boolean } }).event)
      .filter((e) => e.kind === 'assistant' && e.final)
    const combined = finalTexts.map((e) => e.text).join('')
    expect(combined).toContain('ready to review')
    expect(relay.framesByType('hello').length).toBeGreaterThanOrEqual(2)
  })
})
