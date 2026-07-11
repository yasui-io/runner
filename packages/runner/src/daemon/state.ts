/**
 * Daemon state file helpers (`state/daemon.json`) — shared between the
 * daemon and CLI subcommands without pulling the daemon's composition
 * graph (adapters, SDK) into every CLI invocation.
 */

import fs from 'node:fs'
import { controlSocketPath, daemonStatePath } from '../config/paths.js'
import { daemonReachable } from './control.sock.js'

export interface DaemonState {
  pid: number
  startedAt: string
  socketPath: string
  version: string
}

export function readDaemonState(): DaemonState | null {
  try {
    return JSON.parse(fs.readFileSync(daemonStatePath(), 'utf8')) as DaemonState
  } catch {
    return null
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Live pid + socket check (04 §6 — `start` refuses to start twice). */
export async function isDaemonRunning(): Promise<boolean> {
  const state = readDaemonState()
  if (state && pidAlive(state.pid)) {
    if (await daemonReachable(state.socketPath)) return true
  }
  return daemonReachable(controlSocketPath())
}
