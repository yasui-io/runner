/**
 * Local IPC over a unix domain socket (`state/control.sock`) for
 * stop/status/doctor and CLI → daemon nudges (04 §6, §8).
 *
 * Protocol: newline-delimited JSON. Request: `{ "cmd": string, ...args }`.
 * Response: one JSON line `{ "ok": true, ...data }` or `{ "ok": false, "error": string }`.
 */

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { SessionStatus } from '@yasui.io/runner-protocol'

export interface DaemonStatus {
  running: true
  pid: number
  version: string
  runnerId: string
  connected: boolean
  relayUrl: string
  sessions: Array<{ sessionId: string; project: string; status: SessionStatus }>
  outboxDepth: number
  startedAt: string
  updateAvailable: string | null
  draining: boolean
}

export type ControlRequest =
  | { cmd: 'status' }
  | { cmd: 'stop' }
  | { cmd: 'reload-config' }
  | { cmd: 'rescan' }
  | { cmd: 'drain'; targetVersion?: string }

export interface ControlHandlers {
  status: () => Promise<DaemonStatus>
  /** Graceful drain + exit; resolve BEFORE exiting so the reply gets flushed. */
  stop: () => Promise<void>
  /** Re-read config.json; push runner.config; reconnect if token/relayUrl changed. */
  reloadConfig: () => Promise<void>
  /** Immediate project rescan + project.list push. */
  rescan: () => Promise<void>
  /** Stop accepting session.start (update flow). */
  drain: (targetVersion?: string) => Promise<void>
}

export class ControlServer {
  private server: net.Server | null = null

  constructor(
    private readonly socketPath: string,
    private readonly handlers: ControlHandlers,
  ) {}

  async listen(): Promise<void> {
    // Remove a stale socket left by a crashed daemon (caller verified no live daemon).
    try {
      fs.unlinkSync(this.socketPath)
    } catch {
      /* not there */
    }
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 })
    const server = net.createServer((conn) => {
      let buffer = ''
      conn.on('data', (chunk) => {
        buffer += chunk.toString()
        let idx: number
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (line.trim().length > 0) void this.handle(line, conn)
        }
      })
      conn.on('error', () => {
        /* client went away */
      })
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.socketPath, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    try {
      fs.chmodSync(this.socketPath, 0o600)
    } catch {
      /* best effort */
    }
  }

  private async handle(line: string, conn: net.Socket): Promise<void> {
    let request: ControlRequest
    try {
      request = JSON.parse(line) as ControlRequest
    } catch {
      conn.write(JSON.stringify({ ok: false, error: 'malformed request' }) + '\n')
      return
    }
    try {
      switch (request.cmd) {
        case 'status': {
          const status = await this.handlers.status()
          conn.write(JSON.stringify({ ok: true, ...status }) + '\n')
          return
        }
        case 'stop': {
          conn.write(JSON.stringify({ ok: true, stopping: true }) + '\n')
          await new Promise<void>((resolve) => conn.end(() => resolve()))
          await this.handlers.stop()
          return
        }
        case 'reload-config': {
          await this.handlers.reloadConfig()
          conn.write(JSON.stringify({ ok: true }) + '\n')
          return
        }
        case 'rescan': {
          await this.handlers.rescan()
          conn.write(JSON.stringify({ ok: true }) + '\n')
          return
        }
        case 'drain': {
          await this.handlers.drain(request.targetVersion)
          conn.write(JSON.stringify({ ok: true }) + '\n')
          return
        }
        default:
          conn.write(JSON.stringify({ ok: false, error: `unknown command` }) + '\n')
      }
    } catch (err) {
      try {
        conn.write(JSON.stringify({ ok: false, error: (err as Error).message }) + '\n')
      } catch {
        /* client gone */
      }
    }
  }

  async close(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
    this.server = null
    try {
      fs.unlinkSync(this.socketPath)
    } catch {
      /* ignore */
    }
  }
}

/** One-shot request/response against the daemon's control socket. */
export function controlRequest<T = Record<string, unknown>>(
  socketPath: string,
  request: ControlRequest,
  timeoutMs = 20_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath)
    let buffer = ''
    const timer = setTimeout(() => {
      conn.destroy()
      reject(new Error('control socket timeout'))
    }, timeoutMs)
    conn.on('connect', () => {
      conn.write(JSON.stringify(request) + '\n')
    })
    conn.on('data', (chunk) => {
      buffer += chunk.toString()
      const idx = buffer.indexOf('\n')
      if (idx >= 0) {
        clearTimeout(timer)
        conn.end()
        try {
          const parsed = JSON.parse(buffer.slice(0, idx)) as { ok: boolean; error?: string } & T
          if (parsed.ok === false) reject(new Error(parsed.error ?? 'daemon error'))
          else resolve(parsed)
        } catch (err) {
          reject(err as Error)
        }
      }
    })
    conn.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** Is a daemon listening on the control socket? */
export async function daemonReachable(socketPath: string): Promise<boolean> {
  try {
    await controlRequest(socketPath, { cmd: 'status' }, 2_000)
    return true
  } catch {
    return false
  }
}
