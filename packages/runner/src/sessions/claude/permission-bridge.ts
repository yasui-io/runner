/**
 * `canUseTool` ↔ `permission.verdict` promise registry (05 §6).
 *
 * `canUseTool` is a fallthrough, not a gate — it fires exactly when Claude Code would
 * have prompted a human. The bridge emits a `pending` permission event + the
 * `awaiting-permission` status, parks the tool on a promise keyed by `toolUseID`, and
 * resolves it when the control plane forwards a verdict (or the local backstop timer /
 * abort signal fires).
 *
 * Verified against the installed SDK (0.3.202):
 *  - `CanUseTool` options carry `toolUseID: string`, `agentID?: string`,
 *    `suggestions?: PermissionUpdate[]`, `signal: AbortSignal` (plus `title`/
 *    `displayName`/`description` prompt text we do not use — 05 §6's sketch pins
 *    `request` to our own summarizer, which the control plane persists).
 *  - deny results REQUIRE `message: string`.
 */

import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { AdapterOutput, PermissionVerdict } from '../harness-adapter'
import { type AdapterLogger, newEventId, noopLogger, nowIso } from './support'
import { summarizeForPermission } from './tool-summary'

const DEFAULT_DENY_MESSAGE = 'Denied by user from the Yasui dashboard.'
export const TIMEOUT_DENY_MESSAGE = 'Permission request timed out.'
export const INTERRUPTED_DENY_MESSAGE = 'Session interrupted.'
export const ASK_USER_QUESTION_DENY_MESSAGE = 'Ask the user directly in the conversation instead.'

type WaitOutcome =
  | { kind: 'verdict'; verdict: PermissionVerdict }
  | { kind: 'aborted' }

interface PendingEntry {
  eventId: string
  resolve(outcome: WaitOutcome): void
  timer: ReturnType<typeof setTimeout>
  signal: AbortSignal
  onAbort(): void
}

export interface PermissionBridgeOptions {
  sessionId: string
  cwd: string
  /** Server-side timeout; local backstop = this + 1 min (08 §3). */
  permissionTimeoutMinutes: number
  emit(out: AdapterOutput): void
  log?: AdapterLogger
  newId?: () => string
  /** Adapter hook: verdict resolution → tool-event re-summarization + startedAt overwrite (§5.1). */
  onResolved?: (toolUseId: string, verdict: PermissionVerdict) => void
}

export class PermissionBridge {
  private registry = new Map<string, PendingEntry>()
  private readonly log: AdapterLogger
  private readonly newId: () => string

  constructor(private readonly opts: PermissionBridgeOptions) {
    this.log = opts.log ?? noopLogger
    this.newId = opts.newId ?? newEventId
  }

  get pendingCount(): number {
    return this.registry.size
  }

  /**
   * Resolves a pending canUseTool by toolUseId. Unknown ids (timeout race,
   * at-least-once redelivery duplicates) are a logged no-op (04 §9).
   */
  verdict(toolUseId: string, verdict: PermissionVerdict): void {
    const pending = this.registry.get(toolUseId)
    if (!pending) {
      this.log.debug(
        { sessionId: this.opts.sessionId, toolUseId },
        'permission verdict for unknown toolUseId (duplicate or timeout race) — ignored',
      )
      return
    }
    this.settle(toolUseId, pending, { kind: 'verdict', verdict })
  }

  canUseTool: CanUseTool = async (toolName, input, options) => {
    // Decision (05 §6): AskUserQuestion is stripped from context via disallowedTools.
    // Defensive fallback if a call still arrives: auto-deny, no permission event.
    if (toolName === 'AskUserQuestion') {
      this.log.warn(
        { sessionId: this.opts.sessionId },
        'AskUserQuestion reached canUseTool despite disallowedTools — auto-denied',
      )
      return { behavior: 'deny', message: ASK_USER_QUESTION_DENY_MESSAGE }
    }

    const eventId = this.newId()
    const at = nowIso()
    const suggestions = options.suggestions ?? []
    const request = summarizeForPermission(toolName, input, this.opts.cwd)
    const expiresAt = new Date(
      Date.now() + this.opts.permissionTimeoutMinutes * 60_000,
    ).toISOString()

    this.opts.emit({
      type: 'event',
      event: {
        id: eventId,
        at,
        kind: 'permission',
        tool: toolName,
        request,
        status: 'pending',
        // wire-only extension fields (02 §6): persisted, shown in the dock
        toolUseId: options.toolUseID,
        input,
        suggestions,
        expiresAt,
        ...(options.agentID ? { agentId: options.agentID } : {}),
      },
    })
    this.opts.emit({ type: 'status', status: 'awaiting-permission' })

    const outcome = await this.wait(options.toolUseID, eventId, options.signal)

    if (outcome.kind === 'aborted') {
      // interrupt / session end — deny quietly, no revision spam (05 §6)
      return { behavior: 'deny', message: INTERRUPTED_DENY_MESSAGE }
    }

    const verdict = outcome.verdict
    const approved = verdict.behavior === 'allow'
    const effectiveInput = approved && verdict.updatedInput ? verdict.updatedInput : input

    this.opts.emit({
      type: 'event',
      event: {
        id: eventId,
        at,
        kind: 'permission',
        tool: toolName,
        request:
          approved && verdict.updatedInput
            ? summarizeForPermission(toolName, effectiveInput, this.opts.cwd)
            : request,
        status: approved ? 'approved' : 'denied',
        toolUseId: options.toolUseID,
        input: effectiveInput,
        suggestions,
        expiresAt,
        ...(options.agentID ? { agentId: options.agentID } : {}),
        final: true,
      },
    })
    this.opts.emit({ type: 'status', status: 'working' })
    this.opts.onResolved?.(options.toolUseID, verdict)

    if (approved) {
      const result: PermissionResult = {
        behavior: 'allow',
        updatedInput: verdict.updatedInput ?? input,
        updatedPermissions: verdict.appliedSuggestions.length
          ? (verdict.appliedSuggestions as PermissionUpdate[])
          : undefined,
      }
      return result
    }
    return { behavior: 'deny', message: verdict.message ?? DEFAULT_DENY_MESSAGE }
  }

  private wait(toolUseId: string, eventId: string, signal: AbortSignal): Promise<WaitOutcome> {
    return new Promise<WaitOutcome>((resolve) => {
      // Local backstop = server timeout + 1 min — only covers a dead control-plane
      // link; the server's deny verdict normally lands first (05 §6, 08 §3).
      const timeoutMs = (this.opts.permissionTimeoutMinutes + 1) * 60_000
      const timer = setTimeout(() => {
        const pending = this.registry.get(toolUseId)
        if (!pending) return
        this.log.warn(
          { sessionId: this.opts.sessionId, toolUseId },
          'permission backstop timeout — denying locally',
        )
        this.settle(toolUseId, pending, {
          kind: 'verdict',
          verdict: {
            behavior: 'deny',
            message: TIMEOUT_DENY_MESSAGE,
            updatedInput: null,
            appliedSuggestions: [],
          },
        })
      }, timeoutMs)
      timer.unref?.()

      const onAbort = (): void => {
        const pending = this.registry.get(toolUseId)
        if (!pending) return
        this.settle(toolUseId, pending, { kind: 'aborted' })
      }

      if (signal.aborted) {
        clearTimeout(timer)
        resolve({ kind: 'aborted' })
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.registry.set(toolUseId, { eventId, resolve, timer, signal, onAbort })
    })
  }

  private settle(toolUseId: string, pending: PendingEntry, outcome: WaitOutcome): void {
    clearTimeout(pending.timer)
    pending.signal.removeEventListener('abort', pending.onAbort)
    this.registry.delete(toolUseId)
    pending.resolve(outcome)
  }
}
