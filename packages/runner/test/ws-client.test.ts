import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket as ServerWebSocket } from 'ws'
import type { RelayFrame } from '@yasui.io/runner-protocol'
import { createLogger } from '../src/log/logger.js'
import { WsClient, type WsClientHooks } from '../src/daemon/ws-client.js'

const log = createLogger({ level: 'silent' })

interface Harness {
  server: WebSocketServer
  port: number
  client: WsClient
  fatals: Array<{ exitCode: number; message: string }>
  received: RelayFrame[]
  sockets: ServerWebSocket[]
  helloAcks: number
  close: () => Promise<void>
}

async function startHarness(options: {
  onFrame?: (frame: RelayFrame, ws: ServerWebSocket) => void
  autoHelloAck?: boolean
  refreshToken?: () => string | null
  token?: string
} = {}): Promise<Harness> {
  const server = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const port = (server.address() as { port: number }).port

  const harness: Harness = {
    server,
    port,
    client: undefined as unknown as WsClient,
    fatals: [],
    received: [],
    sockets: [],
    helloAcks: 0,
    close: async () => {
      harness.client.stop()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }

  server.on('connection', (ws) => {
    harness.sockets.push(ws)
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as RelayFrame
      harness.received.push(frame)
      if (frame.type === 'hello' && (options.autoHelloAck ?? true)) {
        harness.helloAcks++
        ws.send(
          JSON.stringify({
            id: 'f_srv_helloack',
            type: 'hello.ack',
            ts: new Date().toISOString(),
            payload: {
              protocolVersion: 1,
              runnerId: 'run_test',
              heartbeatIntervalMs: 60_000,
              limits: { maxFrameBytes: 1_048_576, maxToolOutputBytes: 65_536, maxEventBytes: 262_144, deltaFlushMs: 2_000 },
              resume: [],
              serverTime: new Date().toISOString(),
            },
          }),
        )
      }
      options.onFrame?.(frame, ws)
    })
  })

  const currentToken = () => options.token ?? 'yr_testtoken0123456789'
  const hooks: WsClientHooks = {
    connection: () => ({ relayUrl: `ws://127.0.0.1:${port}`, token: currentToken() }),
    refreshConnection: () => {
      const fresh = options.refreshToken?.()
      return fresh ? { relayUrl: `ws://127.0.0.1:${port}`, token: fresh } : null
    },
    buildHello: () => ({
      host: { hostname: 'test', os: 'darwin', arch: 'arm64', kind: 'laptop' },
      harnesses: [],
      caps: ['git'],
      maxConcurrentSessions: 2,
      resume: [],
    }),
    buildRunnerConfig: () => ({ allowBypassPermissions: false, redactionEnabled: true }),
    onHelloAck: () => undefined,
    replay: () => undefined,
    onCommand: () => undefined,
    onEventAck: () => undefined,
    activeSessions: () => 0,
    onFatal: (info) => harness.fatals.push(info),
  }

  harness.client = new WsClient({
    runnerVersion: '0.0.0-test',
    log,
    hooks,
    backoffBaseMs: 30,
    backoffCapMs: 120,
    helloAckTimeoutMs: 2_000,
    heartbeatAckTimeoutMs: 500,
    rateLimitWaitMs: 100,
    cmdAckFlushMs: 10,
  })
  return harness
}

async function until(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 15))
  }
}

let active: Harness | null = null
afterEach(async () => {
  if (active) await active.close()
  active = null
})

describe('WsClient handshake', () => {
  it('sends hello first, then runner.config right after hello.ack', async () => {
    active = await startHarness()
    active.client.start()
    await until(() => active!.received.length >= 2)
    expect(active.received[0]?.type).toBe('hello')
    const hello = active.received[0]!
    expect((hello.payload as { protocolVersion: number }).protocolVersion).toBe(1)
    expect(active.received[1]?.type).toBe('runner.config')
    expect(active.client.connected).toBe(true)
  })
})

describe('WsClient close-code handling (04 §8.1)', () => {
  it('4003 duplicate connection → fatal exit 0, no reconnect', async () => {
    active = await startHarness({
      onFrame: (frame, ws) => {
        if (frame.type === 'runner.config') ws.close(4003, 'superseded')
      },
    })
    active.client.start()
    await until(() => active!.fatals.length > 0)
    expect(active.fatals[0]?.exitCode).toBe(0)
    expect(active.fatals[0]?.message).toContain('superseded')
    const connectionsBefore = active.sockets.length
    await new Promise((r) => setTimeout(r, 300))
    expect(active.sockets.length).toBe(connectionsBefore) // no reconnect
  })

  it('4013 runner revoked → fatal exit 0 with re-pair message', async () => {
    active = await startHarness({
      onFrame: (frame, ws) => {
        if (frame.type === 'runner.config') ws.close(4013, 'revoked')
      },
    })
    active.client.start()
    await until(() => active!.fatals.length > 0)
    expect(active.fatals[0]?.exitCode).toBe(0)
    expect(active.fatals[0]?.message).toContain('re-pair')
  })

  it('4002 protocol version → fatal exit 0 with update hint', async () => {
    active = await startHarness({
      onFrame: (frame, ws) => {
        if (frame.type === 'runner.config') ws.close(4002, 'version')
      },
    })
    active.client.start()
    await until(() => active!.fatals.length > 0)
    expect(active.fatals[0]?.message).toContain('update')
  })

  it('4001 with a rotated token on disk → reconnects with the fresh token', async () => {
    let closes = 0
    active = await startHarness({
      refreshToken: () => 'yr_freshtoken9876543210',
      onFrame: (frame, ws) => {
        if (frame.type === 'runner.config' && closes === 0) {
          closes++
          ws.close(4001, 'unauthorized')
        }
      },
    })
    active.client.start()
    await until(() => active!.sockets.length >= 2 && active!.client.connected)
    expect(active.fatals).toHaveLength(0)
    expect(active.helloAcks).toBe(2)
  })

  it('4001 with no fresh token → treated as 4013 (fatal)', async () => {
    active = await startHarness({
      refreshToken: () => null,
      onFrame: (frame, ws) => {
        if (frame.type === 'runner.config') ws.close(4001, 'unauthorized')
      },
    })
    active.client.start()
    await until(() => active!.fatals.length > 0)
    expect(active.fatals[0]?.exitCode).toBe(0)
    expect(active.fatals[0]?.message).toContain('re-pair')
  })

  it('normal close (1006/1000 from server) → reconnects with backoff', async () => {
    let dropped = false
    active = await startHarness({
      onFrame: (frame, ws) => {
        if (frame.type === 'runner.config' && !dropped) {
          dropped = true
          ws.terminate()
        }
      },
    })
    active.client.start()
    await until(() => active!.helloAcks >= 2 && active!.client.connected)
    expect(active.fatals).toHaveLength(0)
  })
})

describe('WsClient command dedupe + cmd.ack batching', () => {
  it('acks session commands (batched) and ignores duplicate frame ids', async () => {
    const commands: string[] = []
    active = await startHarness({
      onFrame: (frame, ws) => {
        if (frame.type === 'runner.config') {
          const cmd = {
            id: 'cmd_dup_1',
            type: 'session.interrupt',
            sessionId: 'ags_1',
            ts: new Date().toISOString(),
            payload: {},
          }
          ws.send(JSON.stringify(cmd))
          ws.send(JSON.stringify(cmd)) // duplicate
        }
      },
    })
    // Count applied commands through the hook.
    const origOnCommand = active.client['opts'].hooks.onCommand
    active.client['opts'].hooks.onCommand = (frame) => {
      commands.push(frame.type)
      return origOnCommand(frame)
    }
    active.client.start()
    await until(() => active!.received.some((f) => f.type === 'cmd.ack'))
    await new Promise((r) => setTimeout(r, 100))
    expect(commands.filter((t) => t === 'session.interrupt')).toHaveLength(1)
    const acks = active.received.filter((f) => f.type === 'cmd.ack')
    const ackedIds = acks.flatMap((f) => (f.payload as { ids: string[] }).ids)
    expect(ackedIds).toContain('cmd_dup_1')
  })

  it('failed setModel is NOT acked (server persists nothing) while failed message still acks', async () => {
    let failSetModel = true
    const setModelCmd = {
      id: 'cmd_setmodel_1',
      type: 'session.setModel',
      sessionId: 'ags_1',
      ts: new Date().toISOString(),
      payload: { model: 'claude-x' },
    }
    active = await startHarness({
      onFrame: (frame, ws) => {
        if (frame.type === 'runner.config') {
          ws.send(JSON.stringify(setModelCmd))
          ws.send(
            JSON.stringify({
              id: 'cmd_msg_1',
              type: 'session.message',
              sessionId: 'ags_1',
              seq: 1,
              ts: new Date().toISOString(),
              payload: { eventId: 'ev_u1', text: 'hi' },
            }),
          )
        }
      },
    })
    const applied: string[] = []
    active.client['opts'].hooks.onCommand = (frame) => {
      applied.push(frame.type)
      if (frame.type === 'session.setModel' && failSetModel) throw new Error('adapter rejected model')
      if (frame.type === 'session.message') throw new Error('adapter send failed')
    }
    active.client.start()
    const ackedIds = () =>
      active!.received.filter((f) => f.type === 'cmd.ack').flatMap((f) => (f.payload as { ids: string[] }).ids)
    await until(() => ackedIds().includes('cmd_msg_1'))
    await new Promise((r) => setTimeout(r, 100))
    // DB-backed at-least-once frame: failed apply still acks (redelivery must stop)…
    expect(ackedIds()).toContain('cmd_msg_1')
    // …but the failed config-mirroring command is NOT acked (server 504s, persists nothing).
    expect(ackedIds()).not.toContain('cmd_setmodel_1')
    // Error frames went out for both failures.
    expect(active.received.filter((f) => f.type === 'error').length).toBeGreaterThanOrEqual(2)

    // Redelivery with the SAME frame id must re-apply (id evicted from the LRU) and ack on success.
    failSetModel = false
    active.sockets[active.sockets.length - 1]!.send(JSON.stringify(setModelCmd))
    await until(() => ackedIds().includes('cmd_setmodel_1'))
    expect(applied.filter((t) => t === 'session.setModel')).toHaveLength(2)
  })

  it('ignores unknown frame types silently (forward compat)', async () => {
    active = await startHarness({
      onFrame: (frame, ws) => {
        if (frame.type === 'runner.config') {
          ws.send(
            JSON.stringify({ id: 'f_future_1', type: 'totally.new.frame', ts: new Date().toISOString(), payload: { x: 1 } }),
          )
        }
      },
    })
    active.client.start()
    await until(() => active!.client.connected)
    await new Promise((r) => setTimeout(r, 100))
    expect(active.client.connected).toBe(true)
    expect(active.fatals).toHaveLength(0)
  })
})

describe('WsClient droppable sends', () => {
  it('sendDroppable is a no-op while disconnected; sendDurable returns false', async () => {
    active = await startHarness()
    const frame = active.client.envelope('delta', { target: 'assistant', eventId: 'ev', offset: 0, text: 'x' }, 'ags_1')
    expect(active.client.sendDroppable(frame, 'delta')).toBe(false)
    expect(active.client.sendDurable(frame)).toBe(false)
    active.client.start()
    await until(() => active!.client.connected)
    expect(active.client.sendDroppable(frame, 'delta')).toBe(true)
  })
})

describe('WsClient replay gating (02 §3/§9)', () => {
  it('sendDurable stays false until outbox replay completes; replayed frames go first', async () => {
    let releaseHelloAck!: () => void
    const helloAckGate = new Promise<void>((resolve) => (releaseHelloAck = resolve))
    active = await startHarness()
    const client = active.client
    const hooks = client['opts'].hooks
    const replayFrame = client.envelope('event', { event: { id: 'ev_old', kind: 'assistant', text: 'old rev' } }, 'ags_1')
    // Slow resume reconciliation (onHelloAck can await adapter.stop for seconds).
    hooks.onHelloAck = () => helloAckGate
    hooks.replay = (send) => send(replayFrame)

    client.start()
    await until(() => client.connected)
    const newFrame = client.envelope('event', { event: { id: 'ev_old', kind: 'assistant', text: 'newer rev' } }, 'ags_1')
    const rpcFrame = client.envelope('claude.settings.result', {
      opId: 'op_1', action: 'get', target: 'native-user', ok: true,
      settings: {}, revision: null, exists: false, modifiedAt: null, redactedPaths: [],
    })
    // Connected but replay pending — durable sends must stay buffered (outbox).
    expect(client.sendDurable(newFrame)).toBe(false)
    expect(client.sendControl(rpcFrame)).toBe(true)

    releaseHelloAck()
    await until(() => active!.received.some((f) => f.id === replayFrame.id))
    await until(() => active!.received.some((f) => f.id === rpcFrame.id))
    await until(() => client.sendDurable(newFrame)) // ungated once replay resolved
    await until(() => active!.received.some((f) => f.id === newFrame.id))
    const ids = active.received.map((f) => f.id)
    expect(ids.indexOf(replayFrame.id)).toBeLessThan(ids.indexOf(newFrame.id))
    expect(ids.indexOf(replayFrame.id)).toBeLessThan(ids.indexOf(rpcFrame.id))
  })
})

describe('WsClient queue overflow redelivery', () => {
  it('does not remember or ack a command that was dropped before admission', async () => {
    const applied: string[] = []
    active = await startHarness()
    active.client['opts'].hooks.onCommand = (frame) => { applied.push(frame.id) }
    active.client.start()
    await until(() => active!.client.connected && active!.client['replayDone'])

    const command = {
      id: 'cmd_overflow_1',
      type: 'session.interrupt',
      sessionId: 'ags_overflow',
      ts: new Date().toISOString(),
      payload: {},
    }
    active.client['pendingDispatch'] = 1_000
    active.sockets[0]!.send(JSON.stringify(command))
    await until(() => active!.received.some((frame) => frame.type === 'error'))
    expect(applied).toEqual([])
    expect(active.received.some((frame) => frame.type === 'cmd.ack')).toBe(false)

    active.client['pendingDispatch'] = 0
    active.sockets[0]!.send(JSON.stringify(command))
    await until(() => applied.includes(command.id))
    await until(() => active!.received.some((frame) =>
      frame.type === 'cmd.ack' && (frame.payload as { ids?: string[] }).ids?.includes(command.id),
    ))
  })
})
