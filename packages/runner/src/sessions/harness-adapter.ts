/**
 * The canonical HarnessAdapter interface (04-runner.md §9).
 *
 * Adapters translate ONE harness into wire frames. Git is NOT their job — all git ops
 * go through GitService, keyed off the project path, so worktree ops / commit / push
 * behave identically for future OpenCode/Codex adapters.
 */

import type {
  WireSessionEvent, DeltaPayload, SessionStatus, PermissionMode, HarnessId,
} from '@yasui.io/runner-protocol'

export interface HarnessSessionConfig {
  sessionId: string
  projectPath: string                 // resolved cwd (worktree path when worktree used)
  projectTrusted: boolean             // path ∈ trustedProjects (§6) — gates settingSources (08 T5b, 05 §3)
  model: string
  contextWindowTokens: number         // from session.start (Yasui catalog); echoed in HarnessStarted (02 §8, 05 §4)
  permissionMode: PermissionMode      // default | acceptEdits | plan | bypassPermissions
  permissionTimeoutMinutes: number    // server's timeout; runner backstop = this + 1 min (05 §6, 08 §3)
  systemPromptAppend: string | null
  maxTurns: number
  maxBudgetUsd: number
  resumeHarnessSessionId: string | null
  inference: { baseUrl: string; authToken: string }   // in-memory only, never persisted
  paths: { claudeConfigDir: string; sessionLog: string }
}

export interface HarnessStarted {
  harnessSessionId: string            // SDK session_id from the init message
  model: string
  permissionMode: PermissionMode
  slashCommands: string[]
  tools: string[]
  contextWindowTokens: number
}

export type AdapterOutput =
  | { type: 'event';  event: WireSessionEvent }                      // → outbox → `event` frame
  | { type: 'delta';  delta: DeltaPayload }                          // → droppable `delta` frame
  | { type: 'status'; status: SessionStatus; detail?: string }       // → `session.status`
  | { type: 'stats';  stats: { tokensIn: number; tokensOut: number; cacheReadTokens: number
                               contextUsedTokens: number; costUsd: number; turns: number } }
  | { type: 'tool-finished'; toolName: string; mutating: boolean }   // → DiffWatcher trigger (§11)
  | { type: 'ended';  reason: 'completed' | 'failed' | 'interrupted' | 'ended'
                      resultSummary: string | null; errorText: string | null }

export interface PermissionVerdict {
  behavior: 'allow' | 'deny'
  message: string | null
  updatedInput: Record<string, unknown> | null
  appliedSuggestions: unknown[]       // SDK PermissionUpdate[] passthrough
}

export interface HarnessAdapter {
  readonly harness: HarnessId
  /** Boots the harness; resolves when the init handshake completes. */
  start(config: HarnessSessionConfig): Promise<HarnessStarted>
  /** User input. eventId is the control-plane event id (already persisted, seq known). */
  send(input:
    | { kind: 'message'; eventId: string; text: string }
    | { kind: 'slash';   eventId: string; command: string; args: string | null }
  ): Promise<void>
  interrupt(): Promise<void>          // idempotent; no-op when idle
  /** Resolves a pending canUseTool. Unknown toolUseId (timeout race) is a logged no-op. */
  permissionVerdict(toolUseId: string, verdict: PermissionVerdict): void
  setModel(model: string): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  /** Graceful end: interrupt, flush, emit 'ended'. Force-kills subprocess after 10 s. */
  stop(reason: 'user' | 'timeout' | 'budget' | 'admin' | 'shutdown'): Promise<void>
  /** Single consumer (SessionManager). Ends after the 'ended' output. */
  output(): AsyncIterable<AdapterOutput>
}
