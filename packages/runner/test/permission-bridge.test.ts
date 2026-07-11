/**
 * permission-bridge tests (05 §12): verdict resolution, duplicate verdicts, timeout
 * deny, abort-during-pending, updatedInput passthrough, AskUserQuestion fallback.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterOutput } from '../src/sessions/harness-adapter'
import {
  ASK_USER_QUESTION_DENY_MESSAGE,
  INTERRUPTED_DENY_MESSAGE,
  PermissionBridge,
  TIMEOUT_DENY_MESSAGE,
} from '../src/sessions/claude/permission-bridge'

function makeBridge(opts: { timeoutMinutes?: number; onResolved?: (id: string, v: unknown) => void } = {}) {
  const outputs: AdapterOutput[] = []
  const resolved: Array<{ toolUseId: string; verdict: unknown }> = []
  let n = 0
  const bridge = new PermissionBridge({
    sessionId: 'ags_test1',
    cwd: '/home/dev/proj',
    permissionTimeoutMinutes: opts.timeoutMinutes ?? 15,
    emit: (out) => outputs.push(out),
    newId: () => `ev_${String(++n).padStart(4, '0')}`,
    onResolved: (toolUseId, verdict) => resolved.push({ toolUseId, verdict }),
  })
  return { bridge, outputs, resolved }
}

function events(outputs: AdapterOutput[]) {
  return outputs.filter((o) => o.type === 'event').map((o) => o.event)
}
function statuses(outputs: AdapterOutput[]) {
  return outputs.filter((o) => o.type === 'status').map((o) => o.status)
}

function canUseToolOptions(toolUseId: string, extra: Record<string, unknown> = {}) {
  return {
    signal: new AbortController().signal,
    toolUseID: toolUseId,
    requestId: `req_${toolUseId}`,
    suggestions: [],
    ...extra,
  } as Parameters<PermissionBridge['canUseTool']>[2]
}

describe('permission-bridge', () => {
  it('emits pending event + awaiting-permission, resolves allow verdict → approved revision + working', async () => {
    const { bridge, outputs, resolved } = makeBridge()
    const promise = bridge.canUseTool('Bash', { command: 'npm test' }, canUseToolOptions('toolu_p1'))

    const pending = events(outputs)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      kind: 'permission',
      tool: 'Bash',
      request: '$ npm test',
      status: 'pending',
      toolUseId: 'toolu_p1',
      input: { command: 'npm test' },
      suggestions: [],
    })
    expect((pending[0] as { expiresAt: string }).expiresAt).toBeTruthy()
    expect(statuses(outputs)).toEqual(['awaiting-permission'])
    expect(bridge.pendingCount).toBe(1)

    bridge.verdict('toolu_p1', {
      behavior: 'allow',
      message: null,
      updatedInput: null,
      appliedSuggestions: [],
    })
    const result = await promise
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' }, updatedPermissions: undefined })

    const evs = events(outputs)
    expect(evs).toHaveLength(2)
    expect(evs[1]).toMatchObject({ id: evs[0]!.id, kind: 'permission', status: 'approved', final: true })
    expect(statuses(outputs)).toEqual(['awaiting-permission', 'working'])
    expect(resolved).toEqual([
      {
        toolUseId: 'toolu_p1',
        verdict: { behavior: 'allow', message: null, updatedInput: null, appliedSuggestions: [] },
      },
    ])
    expect(bridge.pendingCount).toBe(0)
  })

  it('deny verdict → denied revision with the verdict message', async () => {
    const { bridge, outputs } = makeBridge()
    const promise = bridge.canUseTool('Bash', { command: 'rm -rf /' }, canUseToolOptions('toolu_p2'))
    bridge.verdict('toolu_p2', {
      behavior: 'deny',
      message: 'Too dangerous.',
      updatedInput: null,
      appliedSuggestions: [],
    })
    const result = await promise
    expect(result).toEqual({ behavior: 'deny', message: 'Too dangerous.' })
    expect(events(outputs)[1]).toMatchObject({ kind: 'permission', status: 'denied' })
  })

  it('updatedInput flows through the allow result and re-summarizes the resolution event', async () => {
    const { bridge, outputs, resolved } = makeBridge()
    const promise = bridge.canUseTool('Bash', { command: 'rm -rf /' }, canUseToolOptions('toolu_p3'))
    bridge.verdict('toolu_p3', {
      behavior: 'allow',
      message: null,
      updatedInput: { command: 'rm -rf ./tmp' },
      appliedSuggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }],
    })
    const result = await promise
    expect(result).toMatchObject({
      behavior: 'allow',
      updatedInput: { command: 'rm -rf ./tmp' },
      updatedPermissions: [expect.objectContaining({ type: 'addRules' })],
    })
    const evs = events(outputs)
    expect(evs[1]).toMatchObject({
      kind: 'permission',
      status: 'approved',
      request: '$ rm -rf ./tmp',
      input: { command: 'rm -rf ./tmp' },
    })
    expect(resolved[0]!.verdict).toMatchObject({ updatedInput: { command: 'rm -rf ./tmp' } })
  })

  it('duplicate verdicts are ignored (at-least-once delivery)', async () => {
    const { bridge, outputs } = makeBridge()
    const promise = bridge.canUseTool('Read', { file_path: '/etc/hosts' }, canUseToolOptions('toolu_p4'))
    const verdict = { behavior: 'allow' as const, message: null, updatedInput: null, appliedSuggestions: [] }
    bridge.verdict('toolu_p4', verdict)
    bridge.verdict('toolu_p4', verdict) // duplicate — logged no-op
    bridge.verdict('toolu_unknown', verdict) // unknown — logged no-op
    await promise
    expect(events(outputs)).toHaveLength(2) // one pending + one resolution, no spam
  })

  it('local backstop timeout = permissionTimeoutMinutes + 1 min → deny with timeout message', async () => {
    vi.useFakeTimers()
    try {
      const { bridge, outputs } = makeBridge({ timeoutMinutes: 15 })
      const promise = bridge.canUseTool('Bash', { command: 'ls' }, canUseToolOptions('toolu_p5'))
      vi.advanceTimersByTime(15 * 60_000) // server window — still pending locally
      expect(bridge.pendingCount).toBe(1)
      vi.advanceTimersByTime(60_000 + 1) // +1 min backstop
      const result = await promise
      expect(result).toEqual({ behavior: 'deny', message: TIMEOUT_DENY_MESSAGE })
      expect(events(outputs)[1]).toMatchObject({ kind: 'permission', status: 'denied' })
      expect(bridge.pendingCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('signal abort during pending → deny "Session interrupted.", no revision spam', async () => {
    const { bridge, outputs } = makeBridge()
    const abort = new AbortController()
    const promise = bridge.canUseTool(
      'Bash',
      { command: 'ls' },
      canUseToolOptions('toolu_p6', { signal: abort.signal }),
    )
    abort.abort()
    const result = await promise
    expect(result).toEqual({ behavior: 'deny', message: INTERRUPTED_DENY_MESSAGE })
    // only the pending event — aborts do not revise (§6)
    expect(events(outputs)).toHaveLength(1)
    expect(bridge.pendingCount).toBe(0)
  })

  it('pre-aborted signal resolves immediately as interrupted', async () => {
    const { bridge } = makeBridge()
    const abort = new AbortController()
    abort.abort()
    const result = await bridge.canUseTool(
      'Bash',
      { command: 'ls' },
      canUseToolOptions('toolu_p7', { signal: abort.signal }),
    )
    expect(result).toEqual({ behavior: 'deny', message: INTERRUPTED_DENY_MESSAGE })
  })

  it('AskUserQuestion defensive fallback: auto-deny, no permission event', async () => {
    const { bridge, outputs } = makeBridge()
    const result = await bridge.canUseTool(
      'AskUserQuestion',
      { questions: [] },
      canUseToolOptions('toolu_p8'),
    )
    expect(result).toEqual({ behavior: 'deny', message: ASK_USER_QUESTION_DENY_MESSAGE })
    expect(outputs).toHaveLength(0)
  })

  it('agentID lands on the permission event as agentId (subagent dock badge)', async () => {
    const { bridge, outputs } = makeBridge()
    const promise = bridge.canUseTool(
      'Bash',
      { command: 'ls' },
      canUseToolOptions('toolu_p9', { agentID: 'agent_42' }),
    )
    expect(events(outputs)[0]).toMatchObject({ kind: 'permission', agentId: 'agent_42' })
    bridge.verdict('toolu_p9', { behavior: 'deny', message: null, updatedInput: null, appliedSuggestions: [] })
    const result = await promise
    expect(result).toMatchObject({ behavior: 'deny', message: 'Denied by user from the Yasui dashboard.' })
  })
})
