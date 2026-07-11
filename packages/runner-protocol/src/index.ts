/**
 * relay/v1 — the wire protocol between `yasui-runner` and the Yasui control plane.
 *
 * This file is one of TWO schema copies kept semantically identical (no cross-repo
 * import): the other is `apps/api/src/agents/protocol.ts` in the Yasui monorepo. The
 * shared conformance fixtures in `../fixtures/` keep both honest — a change here must
 * ship with fixture updates in the same change.
 *
 * Compatibility rule: additive changes (new optional payload fields, new frame types)
 * do NOT bump PROTOCOL_VERSION. Both sides ignore unknown payload fields (all payload
 * objects parse with loose semantics) and unknown frame types (see parseRunnerFrame /
 * parseServerFrame). The single strict rejection is the `attachments` denylist on
 * `session.message` / `session.slash` payloads — attachments are a locked v1 non-goal.
 */

import { z } from 'zod'

/* ---------- Version ---------- */

export const PROTOCOL_VERSION = 1
export const MIN_PROTOCOL_VERSION = 1

/* ---------- Limits (also advertised in hello.ack.limits) ---------- */

export const RELAY_LIMITS = {
  /** WS message hard cap — Bun `maxPayloadLength`. Senders must split, never exceed. */
  maxFrameBytes: 1_048_576,
  /** `event` payload cap; runner truncates text fields past this. */
  maxEventBytes: 262_144,
  /** Tool output inside a `tool` event; head+tail truncation with marker past this. */
  maxToolOutputBytes: 65_536,
  /** Single `delta.text` chunk; runner splits larger text into multiple deltas. */
  maxDeltaTextBytes: 8_192,
  /** `git.result` `diff.file` hunks cap; `truncated: true` on the FileDiff past this. */
  maxDiffFileHunksBytes: 524_288,
  /** Consolidated event revision cadence for streaming text. */
  deltaFlushMs: 2_000,
  /** Cumulative streaming text rollover — finalize and continue in a fresh event id. */
  eventRolloverBytes: 16_384,
  /** Default runner heartbeat cadence (authoritative value comes from hello.ack). */
  heartbeatIntervalMs: 20_000,
} as const

/* ---------- Close codes (02 §11) ---------- */

export const CLOSE_CODES = {
  /** Normal shutdown (`yasui-runner stop`, server drain). */
  normal: 1000,
  /** Server restarting — reconnect immediately. */
  serverRestarting: 1012,
  /** Server overloaded / backpressure — reconnect with backoff. */
  serverOverloaded: 1013,
  /** Unauthorized (post-upgrade token revocation). */
  unauthorized: 4001,
  /** Protocol version unsupported. */
  protocolVersionUnsupported: 4002,
  /** Duplicate connection superseded — do NOT auto-reconnect. */
  duplicateConnection: 4003,
  /** Rate limited — reconnect after >= 30 s. */
  rateLimited: 4004,
  /** Protocol violation (bad first frame, repeated malformed frames). */
  protocolViolation: 4008,
  /** Frame too large (repeated). */
  frameTooLarge: 4009,
  /** Runner deleted/banned — stop and require re-pairing. */
  runnerDeleted: 4013,
} as const

export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES]

/* ---------- Error taxonomy (02 §11) ---------- */

export const RELAY_ERROR_CODES = {
  relayUnauthorized: 'yasui_relay_unauthorized',
  relayOriginRejected: 'yasui_relay_origin_rejected',
  relayProtocolVersion: 'yasui_relay_protocol_version',
  relayMalformedFrame: 'yasui_relay_malformed_frame',
  relayUnknownSession: 'yasui_relay_unknown_session',
  relayFrameTooLarge: 'yasui_relay_frame_too_large',
  relayRateLimited: 'yasui_relay_rate_limited',
  relayDuplicateConnection: 'yasui_relay_duplicate_connection',
  runnerOffline: 'yasui_runner_offline',
  runnerHarnessUnavailable: 'yasui_runner_harness_unavailable',
  runnerProjectNotFound: 'yasui_runner_project_not_found',
  runnerSessionLimit: 'yasui_runner_session_limit',
  runnerGitFailed: 'yasui_runner_git_failed',
  runnerInternal: 'yasui_runner_internal',
} as const

export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[keyof typeof RELAY_ERROR_CODES]

/* ---------- Shared unions ---------- */

export const HARNESS_IDS = ['claude-code', 'opencode', 'codex'] as const
export type HarnessId = (typeof HARNESS_IDS)[number]
export const harnessId = z.enum(HARNESS_IDS)

export const SESSION_STATUSES = [
  'streaming',
  'working',
  'awaiting-permission',
  'awaiting-input',
  'idle',
  'completed',
  'failed',
] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]
export const sessionStatus = z.enum(SESSION_STATUSES)

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]
export const permissionMode = z.enum(PERMISSION_MODES)

export const DEVICE_KINDS = ['laptop', 'desktop', 'vps', 'phone'] as const
export type DeviceKind = (typeof DEVICE_KINDS)[number]
/** Alias — "runner" and "device" name the same machine on the wire and in the UI. */
export type RunnerKind = DeviceKind
export const deviceKind = z.enum(DEVICE_KINDS)

const isoTs = z.iso.datetime({ offset: true })

/* ---------- UI shapes carried on the wire (verbatim from the web SessionEvent contract) ---------- */

export type ToolStatus = 'running' | 'success' | 'error'
export const toolStatus = z.enum(['running', 'success', 'error'])

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
}
export const diffLine = z.looseObject({
  kind: z.enum(['add', 'del', 'ctx']),
  text: z.string(),
})

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}
export const diffHunk = z.looseObject({
  header: z.string(),
  lines: z.array(diffLine),
})

export interface FileDiff {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  hunks: DiffHunk[]
  /** Wire-only: set when diff.file hunks were cut at maxDiffFileHunksBytes. */
  truncated?: boolean
}
export const fileDiff = z.looseObject({
  path: z.string(),
  status: z.enum(['modified', 'added', 'deleted', 'renamed']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  hunks: z.array(diffHunk),
  truncated: z.boolean().optional(),
})

export interface Worktree {
  name: string
  branch: string
  path: string
  dirty: boolean
  current: boolean
}
export const worktree = z.looseObject({
  name: z.string(),
  branch: z.string(),
  path: z.string(),
  dirty: z.boolean(),
  current: z.boolean(),
})

export interface ToolCall {
  id: string
  name: string
  summary: string
  status: ToolStatus
  durationMs?: number
  input?: string
  output?: string
  outputStreaming?: boolean
  diff?: { path: string; lines: DiffLine[] }
  errorText?: string
}
export const toolCall = z.looseObject({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  status: toolStatus,
  durationMs: z.number().optional(),
  input: z.string().optional(),
  output: z.string().optional(),
  outputStreaming: z.boolean().optional(),
  diff: z.looseObject({ path: z.string(), lines: z.array(diffLine) }).optional(),
  errorText: z.string().optional(),
})

export interface TodoItem {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}
export const todoItem = z.looseObject({
  id: z.string(),
  text: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
})

export interface AgentRun {
  id: string
  agentType: string
  task: string
  status: 'running' | 'success' | 'error'
  model?: string
  toolUses: number
  tokens: number
  durationMs?: number
  result?: string
}
export const agentRun = z.looseObject({
  id: z.string(),
  agentType: z.string(),
  task: z.string(),
  status: z.enum(['running', 'success', 'error']),
  model: z.string().optional(),
  toolUses: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  durationMs: z.number().optional(),
  result: z.string().optional(),
})

export interface WorkflowPhaseAgent {
  label: string
  status: 'pending' | 'running' | 'success' | 'error'
}
export const workflowPhaseAgent = z.looseObject({
  label: z.string(),
  status: z.enum(['pending', 'running', 'success', 'error']),
})

export interface WorkflowPhase {
  title: string
  agents: WorkflowPhaseAgent[]
}
export const workflowPhase = z.looseObject({
  title: z.string(),
  agents: z.array(workflowPhaseAgent),
})

/* ---------- WireSessionEvent (02 §6) ----------
 *
 * The exact UI `SessionEvent` union, plus wire-only extensions:
 *  - every variant gains optional `final?: boolean` (revision terminality)
 *  - the `permission` variant gains structured fields the control plane persists
 *  - the `user` and `slash` variants allow `clientId?: string` (optimistic-send
 *    dedupe key, 03 §4 persists and echoes it)
 */

export type WireSessionEvent =
  | { id: string; at: string; kind: 'user'; text: string; attachments?: string[]; clientId?: string; final?: boolean }
  | { id: string; at: string; kind: 'slash'; command: string; args?: string; note?: string; clientId?: string; final?: boolean }
  | { id: string; at: string; kind: 'assistant'; text: string; streaming?: boolean; final?: boolean }
  | { id: string; at: string; kind: 'thinking'; text: string; durationMs?: number; streaming?: boolean; final?: boolean }
  | { id: string; at: string; kind: 'tool'; call: ToolCall; final?: boolean }
  | { id: string; at: string; kind: 'tool-group'; calls: ToolCall[]; final?: boolean }
  | { id: string; at: string; kind: 'todo'; todos: TodoItem[]; final?: boolean }
  | { id: string; at: string; kind: 'agent'; run: AgentRun; final?: boolean }
  | {
      id: string
      at: string
      kind: 'workflow'
      name: string
      status: 'running' | 'success' | 'error'
      phases: WorkflowPhase[]
      tokens: number
      final?: boolean
    }
  | {
      id: string
      at: string
      kind: 'permission'
      tool: string
      request: string
      status: 'pending' | 'approved' | 'denied'
      // wire-only extensions ↓ (persisted; UI may ignore)
      toolUseId: string
      input: Record<string, unknown>
      suggestions?: unknown[]
      expiresAt: string
      agentId?: string
      final?: boolean
    }
  | {
      id: string
      at: string
      kind: 'system'
      variant: 'connect' | 'compaction' | 'model-change' | 'info' | 'checkpoint'
      text: string
      final?: boolean
    }
  | { id: string; at: string; kind: 'error'; text: string; final?: boolean }

export type WireSessionEventKind = WireSessionEvent['kind']

const eventBase = {
  id: z.string().min(1).max(64),
  at: isoTs,
  final: z.boolean().optional(),
}

export const wireSessionEvent = z.discriminatedUnion('kind', [
  z.looseObject({
    ...eventBase,
    kind: z.literal('user'),
    text: z.string(),
    attachments: z.array(z.string()).optional(),
    clientId: z.string().max(64).optional(),
  }),
  z.looseObject({
    ...eventBase,
    kind: z.literal('slash'),
    command: z.string(),
    args: z.string().optional(),
    note: z.string().optional(),
    clientId: z.string().max(64).optional(),
  }),
  z.looseObject({
    ...eventBase,
    kind: z.literal('assistant'),
    text: z.string(),
    streaming: z.boolean().optional(),
  }),
  z.looseObject({
    ...eventBase,
    kind: z.literal('thinking'),
    text: z.string(),
    durationMs: z.number().optional(),
    streaming: z.boolean().optional(),
  }),
  z.looseObject({ ...eventBase, kind: z.literal('tool'), call: toolCall }),
  z.looseObject({ ...eventBase, kind: z.literal('tool-group'), calls: z.array(toolCall) }),
  z.looseObject({ ...eventBase, kind: z.literal('todo'), todos: z.array(todoItem) }),
  z.looseObject({ ...eventBase, kind: z.literal('agent'), run: agentRun }),
  z.looseObject({
    ...eventBase,
    kind: z.literal('workflow'),
    name: z.string(),
    status: z.enum(['running', 'success', 'error']),
    phases: z.array(workflowPhase),
    tokens: z.number().int().nonnegative(),
  }),
  z.looseObject({
    ...eventBase,
    kind: z.literal('permission'),
    tool: z.string(),
    request: z.string(),
    status: z.enum(['pending', 'approved', 'denied']),
    toolUseId: z.string(),
    input: z.record(z.string(), z.unknown()),
    suggestions: z.array(z.unknown()).optional(),
    expiresAt: isoTs,
    agentId: z.string().optional(),
  }),
  z.looseObject({
    ...eventBase,
    kind: z.literal('system'),
    variant: z.enum(['connect', 'compaction', 'model-change', 'info', 'checkpoint']),
    text: z.string(),
  }),
  z.looseObject({ ...eventBase, kind: z.literal('error'), text: z.string() }),
])

/* ---------- Delta payload (02 §6) ---------- */

export type DeltaPayload =
  | { target: 'assistant'; eventId: string; offset: number; text: string }
  | { target: 'thinking'; eventId: string; offset: number; text: string }
  // Reserved — not emitted in v1 (per-harness capability kept in the schema for v2).
  | { target: 'tool-output'; eventId: string; toolCallId: string; offset: number; text: string }

export const deltaPayload = z.discriminatedUnion('target', [
  z.looseObject({
    target: z.literal('assistant'),
    eventId: z.string(),
    offset: z.number().int().nonnegative(),
    text: z.string(),
  }),
  z.looseObject({
    target: z.literal('thinking'),
    eventId: z.string(),
    offset: z.number().int().nonnegative(),
    text: z.string(),
  }),
  z.looseObject({
    target: z.literal('tool-output'),
    eventId: z.string(),
    toolCallId: z.string(),
    offset: z.number().int().nonnegative(),
    text: z.string(),
  }),
])

/* ---------- Frame envelope (02 §5) ---------- */

export interface RelayFrame<TType extends string = string, TPayload = unknown> {
  /** Sender-generated unique frame id (cuid2). Idempotency + ack key. */
  id: string
  type: TType
  /** Present on every session-scoped frame; absent on runner-scoped frames. */
  sessionId?: string
  /** Server-assigned per-session event seq. Set by the SERVER only:
   *  on `event.ack` payloads and on frames the server originates that were
   *  persisted as AgentSessionEvent rows (session.message / session.slash). */
  seq?: number
  /** Sender clock, ISO-8601 with ms. Informational — ordering is by arrival + seq. */
  ts: string
  payload: TPayload
}

export const frameBase = z.object({
  id: z.string().min(8).max(64),
  type: z.string().min(1).max(64),
  sessionId: z.string().max(64).optional(),
  seq: z.number().int().positive().optional(),
  ts: isoTs,
})

const requiredSessionId = z.string().min(1).max(64)

/* ---------- Runner → server payloads (02 §7) ---------- */

export interface HarnessInstall {
  harness: HarnessId
  version: string
  sdkVersion?: string
}
export const harnessInstall = z.looseObject({
  harness: harnessId,
  version: z.string(),
  sdkVersion: z.string().optional(),
})

export interface RunnerHost {
  hostname: string
  os: string
  arch: string
  kind: DeviceKind
  locationHint?: string
}
export const runnerHost = z.looseObject({
  hostname: z.string(),
  os: z.string(),
  arch: z.string(),
  kind: deviceKind,
  locationHint: z.string().optional(),
})

export interface HelloResumeEntry {
  sessionId: string
  lastAppliedInputSeq: number
  bufferedEventFrames: number
  status: SessionStatus
}
export const helloResumeEntry = z.looseObject({
  sessionId: z.string(),
  lastAppliedInputSeq: z.number().int().nonnegative(),
  bufferedEventFrames: z.number().int().nonnegative(),
  status: sessionStatus,
})

export interface HelloPayload {
  protocolVersion: number
  minProtocolVersion: number
  runnerVersion: string
  host: RunnerHost
  harnesses: HarnessInstall[]
  caps: string[]
  maxConcurrentSessions: number
  resume?: HelloResumeEntry[]
}
export const helloPayload = z.looseObject({
  protocolVersion: z.number().int().positive(),
  minProtocolVersion: z.number().int().positive(),
  runnerVersion: z.string(),
  host: runnerHost,
  harnesses: z.array(harnessInstall),
  caps: z.array(z.string()),
  maxConcurrentSessions: z.number().int().positive(),
  resume: z.array(helloResumeEntry).optional(),
})

export interface HeartbeatPayload {
  activeSessions: number
  load1?: number
  freeMemMb?: number
}
export const heartbeatPayload = z.looseObject({
  activeSessions: z.number().int().nonnegative(),
  load1: z.number().optional(),
  freeMemMb: z.number().optional(),
})

export interface EventPayload {
  event: WireSessionEvent
}
export const eventPayload = z.looseObject({ event: wireSessionEvent })

export interface SessionStartedPayload {
  startId: string
  harnessSessionId: string
  model: string
  permissionMode: PermissionMode
  slashCommands: string[]
  /** NOTE: the Claude SDK init message reports the pre-rename tool name "Task". */
  tools: string[]
  contextWindowTokens: number
  cwd: string
  gitBranch: string
  worktree: string | null
}
export const sessionStartedPayload = z.looseObject({
  startId: z.string(),
  harnessSessionId: z.string(),
  model: z.string(),
  permissionMode,
  slashCommands: z.array(z.string()),
  tools: z.array(z.string()),
  contextWindowTokens: z.number().int().positive(),
  cwd: z.string(),
  gitBranch: z.string(),
  worktree: z.string().nullable(),
})

export interface SessionStatusPayload {
  status: SessionStatus
  detail?: string
}
export const sessionStatusPayload = z.looseObject({
  status: sessionStatus,
  detail: z.string().optional(),
})

export interface SessionStatsPayload {
  tokensIn: number
  tokensOut: number
  cacheReadTokens: number
  contextUsedTokens: number
  costUsd: number
  turns: number
}
export const sessionStatsPayload = z.looseObject({
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  contextUsedTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  turns: z.number().int().nonnegative(),
})

export interface SessionDiffPayload {
  additions: number
  deletions: number
  /** Summary only — files carry empty hunks; full hunks via git.request op diff.file. */
  files: FileDiff[]
}
export const sessionDiffPayload = z.looseObject({
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  files: z.array(fileDiff),
})

export const SESSION_ENDED_REASONS = ['completed', 'failed', 'interrupted', 'ended'] as const
export type SessionEndedReason = (typeof SESSION_ENDED_REASONS)[number]

export interface SessionEndedPayload {
  reason: SessionEndedReason
  resultSummary: string | null
  errorText: string | null
}
export const sessionEndedPayload = z.looseObject({
  reason: z.enum(SESSION_ENDED_REASONS),
  resultSummary: z.string().nullable(),
  errorText: z.string().nullable(),
})

/* ---------- Git ops (02 §8 op table) ---------- */

export const GIT_OPS = [
  'status',
  'diff',
  'diff.file',
  'commit',
  'push',
  'discard',
  'worktree.list',
  'worktree.create',
  'worktree.remove',
] as const
export type GitOp = (typeof GIT_OPS)[number]
export const gitOp = z.enum(GIT_OPS)

export interface GitStatusResult {
  branch: string
  upstream: string | null
  dirty: boolean
  ahead: number
  behind: number
  staged: string[]
  unstaged: string[]
  untracked: string[]
}
export const gitStatusResult = z.looseObject({
  branch: z.string(),
  upstream: z.string().nullable(),
  dirty: z.boolean(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  staged: z.array(z.string()),
  unstaged: z.array(z.string()),
  untracked: z.array(z.string()),
})

/** `diff` result — session.diff-shaped summary (empty hunks). */
export type GitDiffResult = SessionDiffPayload
export const gitDiffResult = sessionDiffPayload

/** `diff.file` result — one FileDiff with full hunks (truncated: true past 512 KiB). */
export type GitDiffFileResult = FileDiff
export const gitDiffFileResult = fileDiff

export interface GitCommitResult {
  sha: string
  branch: string
  filesCommitted: number
}
export const gitCommitResult = z.looseObject({
  sha: z.string(),
  branch: z.string(),
  filesCommitted: z.number().int().nonnegative(),
})

export interface GitPushResult {
  remote: string
  branch: string
  url?: string
}
export const gitPushResult = z.looseObject({
  remote: z.string(),
  branch: z.string(),
  url: z.string().optional(),
})

export interface GitDiscardResult {
  discarded: string[]
}
export const gitDiscardResult = z.looseObject({ discarded: z.array(z.string()) })

export interface WorktreeListResult {
  worktrees: Worktree[]
}
export const worktreeListResult = z.looseObject({ worktrees: z.array(worktree) })

export interface WorktreeCreateResult {
  worktree: Worktree
}
export const worktreeCreateResult = z.looseObject({ worktree })

export interface WorktreeRemoveResult {
  removed: true
}
export const worktreeRemoveResult = z.looseObject({ removed: z.literal(true) })

export type GitResult =
  | GitStatusResult
  | GitDiffResult
  | GitDiffFileResult
  | GitCommitResult
  | GitPushResult
  | GitDiscardResult
  | WorktreeListResult
  | WorktreeCreateResult
  | WorktreeRemoveResult

export interface GitResultError {
  code: string
  message: string
  stderr?: string
}
export const gitResultError = z.looseObject({
  code: z.string(),
  message: z.string(),
  stderr: z.string().optional(),
})

export type GitResultPayload =
  | { opId: string; op: 'status'; ok: true; result: GitStatusResult }
  | { opId: string; op: 'diff'; ok: true; result: GitDiffResult }
  | { opId: string; op: 'diff.file'; ok: true; result: GitDiffFileResult }
  | { opId: string; op: 'commit'; ok: true; result: GitCommitResult }
  | { opId: string; op: 'push'; ok: true; result: GitPushResult }
  | { opId: string; op: 'discard'; ok: true; result: GitDiscardResult }
  | { opId: string; op: 'worktree.list'; ok: true; result: WorktreeListResult }
  | { opId: string; op: 'worktree.create'; ok: true; result: WorktreeCreateResult }
  | { opId: string; op: 'worktree.remove'; ok: true; result: WorktreeRemoveResult }
  | { opId: string; op: GitOp; ok: false; error: GitResultError }

const gitResultOk = z.discriminatedUnion('op', [
  z.looseObject({ opId: z.string(), op: z.literal('status'), ok: z.literal(true), result: gitStatusResult }),
  z.looseObject({ opId: z.string(), op: z.literal('diff'), ok: z.literal(true), result: gitDiffResult }),
  z.looseObject({ opId: z.string(), op: z.literal('diff.file'), ok: z.literal(true), result: gitDiffFileResult }),
  z.looseObject({ opId: z.string(), op: z.literal('commit'), ok: z.literal(true), result: gitCommitResult }),
  z.looseObject({ opId: z.string(), op: z.literal('push'), ok: z.literal(true), result: gitPushResult }),
  z.looseObject({ opId: z.string(), op: z.literal('discard'), ok: z.literal(true), result: gitDiscardResult }),
  z.looseObject({ opId: z.string(), op: z.literal('worktree.list'), ok: z.literal(true), result: worktreeListResult }),
  z.looseObject({ opId: z.string(), op: z.literal('worktree.create'), ok: z.literal(true), result: worktreeCreateResult }),
  z.looseObject({ opId: z.string(), op: z.literal('worktree.remove'), ok: z.literal(true), result: worktreeRemoveResult }),
])
const gitResultErr = z.looseObject({
  opId: z.string(),
  op: gitOp,
  ok: z.literal(false),
  error: gitResultError,
})
export const gitResultPayload = z.union([gitResultOk, gitResultErr])

export interface Project {
  path: string
  name: string
  branch: string
  dirty: boolean
  remoteUrl?: string | null
  trusted: boolean
  lastCommitAt?: string | null
}
export const project = z.looseObject({
  path: z.string(),
  name: z.string(),
  branch: z.string(),
  dirty: z.boolean(),
  remoteUrl: z.string().nullable().optional(),
  trusted: z.boolean(),
  lastCommitAt: isoTs.nullable().optional(),
})

export interface ProjectListPayload {
  opId: string
  projects: Project[]
}
export const projectListPayload = z.looseObject({
  opId: z.string(),
  projects: z.array(project),
})

export interface RunnerConfigPayload {
  allowBypassPermissions: boolean
  redactionEnabled: boolean
  remoteClaudeSettingsEnabled?: boolean
}
export const runnerConfigPayload = z.looseObject({
  allowBypassPermissions: z.boolean(),
  redactionEnabled: z.boolean(),
  remoteClaudeSettingsEnabled: z.boolean().optional().default(false),
})

export interface CmdAckPayload {
  ids: string[]
}
export const cmdAckPayload = z.looseObject({ ids: z.array(z.string()) })

export interface ErrorPayload {
  code: string
  message: string
  details?: unknown
}
export const errorPayload = z.looseObject({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
})

/* ---------- Server → runner payloads (02 §8) ---------- */

export interface HelloAckResumeEntry {
  sessionId: string
  lastPersistedSeq: number
  /** live = resume streaming; ending = session.end follows; unknown = kill + discard. */
  state: 'live' | 'ending' | 'unknown'
}
export const helloAckResumeEntry = z.looseObject({
  sessionId: z.string(),
  lastPersistedSeq: z.number().int().nonnegative(),
  state: z.enum(['live', 'ending', 'unknown']),
})

export interface RelayLimits {
  maxFrameBytes: number
  maxToolOutputBytes: number
  maxEventBytes: number
  deltaFlushMs: number
}
export const relayLimits = z.looseObject({
  maxFrameBytes: z.number().int().positive(),
  maxToolOutputBytes: z.number().int().positive(),
  maxEventBytes: z.number().int().positive(),
  deltaFlushMs: z.number().int().positive(),
})

export interface HelloAckPayload {
  protocolVersion: number
  runnerId: string
  heartbeatIntervalMs: number
  limits: RelayLimits
  resume?: HelloAckResumeEntry[]
  serverTime: string
}
export const helloAckPayload = z.looseObject({
  protocolVersion: z.number().int().positive(),
  runnerId: z.string(),
  heartbeatIntervalMs: z.number().int().positive(),
  limits: relayLimits,
  resume: z.array(helloAckResumeEntry).optional(),
  serverTime: isoTs,
})

export const heartbeatAckPayload = z.looseObject({})
export type HeartbeatAckPayload = Record<string, unknown>

export interface EventAckEntry {
  frameId: string
  sessionId: string
  seq: number
}
export const eventAckEntry = z.looseObject({
  frameId: z.string(),
  sessionId: z.string(),
  seq: z.number().int().positive(),
})

export interface EventAckPayload {
  acks: EventAckEntry[]
}
export const eventAckPayload = z.looseObject({ acks: z.array(eventAckEntry) })

export interface SessionStartPayload {
  harness: HarnessId
  project: { path: string; projectId: string }
  worktree: { create: boolean; name: string; branch?: string | null } | null
  model: string
  contextWindowTokens: number
  permissionMode: PermissionMode
  permissionTimeoutMinutes: number
  systemPromptAppend: string | null
  maxTurns: number
  maxBudgetUsd: number
  resumeHarnessSessionId: string | null
  /** Session-scoped inference key — plaintext, WS-only, never written to disk. */
  inference: { baseUrl: string; authToken: string; expiresAt: string }
}
export const sessionStartPayload = z.looseObject({
  harness: harnessId,
  project: z.looseObject({ path: z.string(), projectId: z.string() }),
  worktree: z
    .looseObject({ create: z.boolean(), name: z.string(), branch: z.string().nullable().optional() })
    .nullable(),
  model: z.string(),
  contextWindowTokens: z.number().int().positive(),
  permissionMode,
  permissionTimeoutMinutes: z.number().int().positive(),
  systemPromptAppend: z.string().nullable(),
  maxTurns: z.number().int().positive(),
  maxBudgetUsd: z.number().nonnegative(),
  resumeHarnessSessionId: z.string().nullable(),
  inference: z.looseObject({
    baseUrl: z.string(),
    authToken: z.string(),
    expiresAt: isoTs,
  }),
})

/** The one strict rejection in the protocol: attachments are a locked v1 non-goal. */
const rejectAttachments = (value: Record<string, unknown>, ctx: z.RefinementCtx) => {
  if ('attachments' in value) {
    ctx.addIssue({ code: 'custom', message: 'attachments are not supported in relay/v1', path: ['attachments'] })
  }
}

export interface SessionMessagePayload {
  eventId: string
  text: string
  /** Optimistic-send dedupe key, echoed on the SSE event (03 §4). */
  clientId?: string
}
export const sessionMessagePayload = z
  .looseObject({
    eventId: z.string(),
    text: z.string(),
    clientId: z.string().max(64).optional(),
  })
  .superRefine(rejectAttachments)

export interface SessionSlashPayload {
  eventId: string
  command: string
  args?: string | null
  clientId?: string
}
export const sessionSlashPayload = z
  .looseObject({
    eventId: z.string(),
    command: z.string(),
    args: z.string().nullable().optional(),
    clientId: z.string().max(64).optional(),
  })
  .superRefine(rejectAttachments)

export const sessionInterruptPayload = z.looseObject({})
export type SessionInterruptPayload = Record<string, unknown>

export interface SessionSetModelPayload {
  model: string
}
export const sessionSetModelPayload = z.looseObject({ model: z.string() })

export interface SessionSetPermissionModePayload {
  mode: PermissionMode
}
export const sessionSetPermissionModePayload = z.looseObject({ mode: permissionMode })

export interface PermissionVerdictPayload {
  permissionEventId: string
  toolUseId: string
  behavior: 'allow' | 'deny'
  /** Deny message shown to the model. */
  message: string | null
  updatedInput: Record<string, unknown> | null
  /** SDK PermissionUpdate[] passthrough, persisted runner-side. */
  appliedSuggestions: unknown[]
}
export const permissionVerdictPayload = z.looseObject({
  permissionEventId: z.string(),
  toolUseId: z.string(),
  behavior: z.enum(['allow', 'deny']),
  message: z.string().nullable(),
  updatedInput: z.record(z.string(), z.unknown()).nullable(),
  appliedSuggestions: z.array(z.unknown()),
})

export type GitRequestPayload =
  | { opId: string; op: 'status'; args: { path: string } }
  | { opId: string; op: 'diff'; args: { path: string; base?: string } }
  | { opId: string; op: 'diff.file'; args: { path: string; file: string; base?: string } }
  | { opId: string; op: 'commit'; args: { path: string; message: string; files?: string[] } }
  | { opId: string; op: 'push'; args: { path: string; remote?: string; setUpstream?: boolean } }
  | { opId: string; op: 'discard'; args: { path: string; files?: string[] } }
  | { opId: string; op: 'worktree.list'; args: { path: string } }
  | { opId: string; op: 'worktree.create'; args: { path: string; name: string; branch?: string } }
  | { opId: string; op: 'worktree.remove'; args: { path: string; name: string; force?: boolean } }

export const gitRequestPayload = z.discriminatedUnion('op', [
  z.looseObject({
    opId: z.string(),
    op: z.literal('status'),
    args: z.looseObject({ path: z.string() }),
  }),
  z.looseObject({
    opId: z.string(),
    op: z.literal('diff'),
    args: z.looseObject({ path: z.string(), base: z.string().optional() }),
  }),
  z.looseObject({
    opId: z.string(),
    op: z.literal('diff.file'),
    args: z.looseObject({ path: z.string(), file: z.string(), base: z.string().optional() }),
  }),
  z.looseObject({
    opId: z.string(),
    op: z.literal('commit'),
    args: z.looseObject({ path: z.string(), message: z.string(), files: z.array(z.string()).optional() }),
  }),
  z.looseObject({
    opId: z.string(),
    op: z.literal('push'),
    args: z.looseObject({ path: z.string(), remote: z.string().optional(), setUpstream: z.boolean().optional() }),
  }),
  z.looseObject({
    opId: z.string(),
    op: z.literal('discard'),
    args: z.looseObject({ path: z.string(), files: z.array(z.string()).optional() }),
  }),
  z.looseObject({
    opId: z.string(),
    op: z.literal('worktree.list'),
    args: z.looseObject({ path: z.string() }),
  }),
  z.looseObject({
    opId: z.string(),
    op: z.literal('worktree.create'),
    args: z.looseObject({ path: z.string(), name: z.string(), branch: z.string().optional() }),
  }),
  z.looseObject({
    opId: z.string(),
    op: z.literal('worktree.remove'),
    args: z.looseObject({ path: z.string(), name: z.string(), force: z.boolean().optional() }),
  }),
])

export interface ProjectScanPayload {
  opId: string
}
export const projectScanPayload = z.looseObject({ opId: z.string() })

export type ClaudeSettingsTarget = 'native-user'
export type ClaudeSettingsObject = Record<string, unknown>
export type ClaudeSettingsPatchOperation =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'delete'; path: string[] }

export const claudeSettingsPatchOperation = z.discriminatedUnion('op', [
  z.looseObject({
    op: z.literal('set'),
    path: z.array(z.string().min(1).max(256)).min(1).max(16),
    value: z.unknown(),
  }),
  z.looseObject({
    op: z.literal('delete'),
    path: z.array(z.string().min(1).max(256)).min(1).max(16),
  }),
])

export type ClaudeSettingsRequestPayload =
  | { opId: string; action: 'get'; target: ClaudeSettingsTarget }
  | {
      opId: string
      action: 'update'
      target: ClaudeSettingsTarget
      patch: ClaudeSettingsPatchOperation[]
      expectedRevision: string | null
      allowMalformedReset?: boolean
    }

export const claudeSettingsRequestPayload = z.discriminatedUnion('action', [
  z.looseObject({
    opId: z.string(),
    action: z.literal('get'),
    target: z.literal('native-user'),
  }),
  z.looseObject({
    opId: z.string(),
    action: z.literal('update'),
    target: z.literal('native-user'),
    patch: z.array(claudeSettingsPatchOperation).min(1).max(256),
    expectedRevision: z.string().nullable(),
    allowMalformedReset: z.boolean().optional().default(false),
  }),
])

export type ClaudeSettingsResultPayload =
  | {
      opId: string
      action: 'get' | 'update'
      target: ClaudeSettingsTarget
      ok: true
      settings: ClaudeSettingsObject
      revision: string | null
      exists: boolean
      modifiedAt: string | null
      redactedPaths: string[][]
      parseError?: string
    }
  | {
      opId: string
      action: 'get' | 'update'
      target: ClaudeSettingsTarget
      ok: false
      error: { code: string; message: string }
      revision?: string | null
    }

export const claudeSettingsResultPayload = z.discriminatedUnion('ok', [
  z.looseObject({
    opId: z.string(),
    action: z.enum(['get', 'update']),
    target: z.literal('native-user'),
    ok: z.literal(true),
    settings: z.record(z.string(), z.unknown()),
    revision: z.string().nullable(),
    exists: z.boolean(),
    modifiedAt: isoTs.nullable(),
    redactedPaths: z.array(z.array(z.string())),
    parseError: z.string().optional(),
  }),
  z.looseObject({
    opId: z.string(),
    action: z.enum(['get', 'update']),
    target: z.literal('native-user'),
    ok: z.literal(false),
    error: z.looseObject({ code: z.string(), message: z.string() }),
    revision: z.string().nullable().optional(),
  }),
])

export const SESSION_END_REASONS = ['user', 'timeout', 'budget', 'admin'] as const
export type SessionEndReason = (typeof SESSION_END_REASONS)[number]

export interface SessionEndPayload {
  reason: SessionEndReason
}
export const sessionEndPayload = z.looseObject({ reason: z.enum(SESSION_END_REASONS) })

export interface RunnerUpdatePayload {
  targetVersion: string
  /** Drain deadline — the runner stops waiting for active sessions past this. */
  deadline: string
}
export const runnerUpdatePayload = z.looseObject({
  targetVersion: z.string(),
  deadline: isoTs,
})

/* ---------- Frame catalogs ---------- */

export type HelloFrame = RelayFrame<'hello', HelloPayload>
export type HeartbeatFrame = RelayFrame<'heartbeat', HeartbeatPayload>
export type EventFrame = RelayFrame<'event', EventPayload> & { sessionId: string }
export type DeltaFrame = RelayFrame<'delta', DeltaPayload> & { sessionId: string }
export type SessionStartedFrame = RelayFrame<'session.started', SessionStartedPayload> & { sessionId: string }
export type SessionStatusFrame = RelayFrame<'session.status', SessionStatusPayload> & { sessionId: string }
export type SessionStatsFrame = RelayFrame<'session.stats', SessionStatsPayload> & { sessionId: string }
export type SessionDiffFrame = RelayFrame<'session.diff', SessionDiffPayload> & { sessionId: string }
export type SessionEndedFrame = RelayFrame<'session.ended', SessionEndedPayload> & { sessionId: string }
export type GitResultFrame = RelayFrame<'git.result', GitResultPayload>
export type ProjectListFrame = RelayFrame<'project.list', ProjectListPayload>
export type ClaudeSettingsResultFrame = RelayFrame<'claude.settings.result', ClaudeSettingsResultPayload>
export type RunnerConfigFrame = RelayFrame<'runner.config', RunnerConfigPayload>
export type CmdAckFrame = RelayFrame<'cmd.ack', CmdAckPayload>
export type ErrorFrame = RelayFrame<'error', ErrorPayload>

export type RunnerToServerFrame =
  | HelloFrame
  | HeartbeatFrame
  | EventFrame
  | DeltaFrame
  | SessionStartedFrame
  | SessionStatusFrame
  | SessionStatsFrame
  | SessionDiffFrame
  | SessionEndedFrame
  | GitResultFrame
  | ProjectListFrame
  | ClaudeSettingsResultFrame
  | RunnerConfigFrame
  | CmdAckFrame
  | ErrorFrame

export type HelloAckFrame = RelayFrame<'hello.ack', HelloAckPayload>
export type HeartbeatAckFrame = RelayFrame<'heartbeat.ack', HeartbeatAckPayload>
export type EventAckFrame = RelayFrame<'event.ack', EventAckPayload>
export type SessionStartFrame = RelayFrame<'session.start', SessionStartPayload> & { sessionId: string }
export type SessionMessageFrame = RelayFrame<'session.message', SessionMessagePayload> & {
  sessionId: string
  seq: number
}
export type SessionSlashFrame = RelayFrame<'session.slash', SessionSlashPayload> & {
  sessionId: string
  seq: number
}
export type SessionInterruptFrame = RelayFrame<'session.interrupt', SessionInterruptPayload> & { sessionId: string }
export type SessionSetModelFrame = RelayFrame<'session.setModel', SessionSetModelPayload> & { sessionId: string }
export type SessionSetPermissionModeFrame = RelayFrame<'session.setPermissionMode', SessionSetPermissionModePayload> & {
  sessionId: string
}
export type PermissionVerdictFrame = RelayFrame<'permission.verdict', PermissionVerdictPayload> & { sessionId: string }
export type GitRequestFrame = RelayFrame<'git.request', GitRequestPayload>
export type ProjectScanFrame = RelayFrame<'project.scan', ProjectScanPayload>
export type ClaudeSettingsRequestFrame = RelayFrame<'claude.settings.request', ClaudeSettingsRequestPayload>
export type SessionEndFrame = RelayFrame<'session.end', SessionEndPayload> & { sessionId: string }
export type RunnerUpdateFrame = RelayFrame<'runner.update', RunnerUpdatePayload>

export type ServerToRunnerFrame =
  | HelloAckFrame
  | HeartbeatAckFrame
  | EventAckFrame
  | SessionStartFrame
  | SessionMessageFrame
  | SessionSlashFrame
  | SessionInterruptFrame
  | SessionSetModelFrame
  | SessionSetPermissionModeFrame
  | PermissionVerdictFrame
  | GitRequestFrame
  | ProjectScanFrame
  | ClaudeSettingsRequestFrame
  | SessionEndFrame
  | RunnerUpdateFrame
  | ErrorFrame

/* ---------- Frame schemas & discriminated unions ---------- */

export const helloFrame = frameBase.extend({ type: z.literal('hello'), payload: helloPayload })
export const heartbeatFrame = frameBase.extend({ type: z.literal('heartbeat'), payload: heartbeatPayload })
export const eventFrame = frameBase.extend({
  type: z.literal('event'),
  sessionId: requiredSessionId,
  payload: eventPayload,
})
export const deltaFrame = frameBase.extend({
  type: z.literal('delta'),
  sessionId: requiredSessionId,
  payload: deltaPayload,
})
export const sessionStartedFrame = frameBase.extend({
  type: z.literal('session.started'),
  sessionId: requiredSessionId,
  payload: sessionStartedPayload,
})
export const sessionStatusFrame = frameBase.extend({
  type: z.literal('session.status'),
  sessionId: requiredSessionId,
  payload: sessionStatusPayload,
})
export const sessionStatsFrame = frameBase.extend({
  type: z.literal('session.stats'),
  sessionId: requiredSessionId,
  payload: sessionStatsPayload,
})
export const sessionDiffFrame = frameBase.extend({
  type: z.literal('session.diff'),
  sessionId: requiredSessionId,
  payload: sessionDiffPayload,
})
export const sessionEndedFrame = frameBase.extend({
  type: z.literal('session.ended'),
  sessionId: requiredSessionId,
  payload: sessionEndedPayload,
})
export const gitResultFrame = frameBase.extend({ type: z.literal('git.result'), payload: gitResultPayload })
export const projectListFrame = frameBase.extend({ type: z.literal('project.list'), payload: projectListPayload })
export const claudeSettingsResultFrame = frameBase.extend({
  type: z.literal('claude.settings.result'),
  payload: claudeSettingsResultPayload,
})
export const runnerConfigFrame = frameBase.extend({ type: z.literal('runner.config'), payload: runnerConfigPayload })
export const cmdAckFrame = frameBase.extend({ type: z.literal('cmd.ack'), payload: cmdAckPayload })
export const errorFrame = frameBase.extend({ type: z.literal('error'), payload: errorPayload })

export const runnerToServerFrame = z.discriminatedUnion('type', [
  helloFrame,
  heartbeatFrame,
  eventFrame,
  deltaFrame,
  sessionStartedFrame,
  sessionStatusFrame,
  sessionStatsFrame,
  sessionDiffFrame,
  sessionEndedFrame,
  gitResultFrame,
  projectListFrame,
  claudeSettingsResultFrame,
  runnerConfigFrame,
  cmdAckFrame,
  errorFrame,
])

export const helloAckFrame = frameBase.extend({ type: z.literal('hello.ack'), payload: helloAckPayload })
export const heartbeatAckFrame = frameBase.extend({ type: z.literal('heartbeat.ack'), payload: heartbeatAckPayload })
export const eventAckFrame = frameBase.extend({ type: z.literal('event.ack'), payload: eventAckPayload })
export const sessionStartFrame = frameBase.extend({
  type: z.literal('session.start'),
  sessionId: requiredSessionId,
  payload: sessionStartPayload,
})
export const sessionMessageFrame = frameBase.extend({
  type: z.literal('session.message'),
  sessionId: requiredSessionId,
  // The server persists the user event first, so seq is always assigned here.
  seq: z.number().int().positive(),
  payload: sessionMessagePayload,
})
export const sessionSlashFrame = frameBase.extend({
  type: z.literal('session.slash'),
  sessionId: requiredSessionId,
  seq: z.number().int().positive(),
  payload: sessionSlashPayload,
})
export const sessionInterruptFrame = frameBase.extend({
  type: z.literal('session.interrupt'),
  sessionId: requiredSessionId,
  payload: sessionInterruptPayload,
})
export const sessionSetModelFrame = frameBase.extend({
  type: z.literal('session.setModel'),
  sessionId: requiredSessionId,
  payload: sessionSetModelPayload,
})
export const sessionSetPermissionModeFrame = frameBase.extend({
  type: z.literal('session.setPermissionMode'),
  sessionId: requiredSessionId,
  payload: sessionSetPermissionModePayload,
})
export const permissionVerdictFrame = frameBase.extend({
  type: z.literal('permission.verdict'),
  sessionId: requiredSessionId,
  payload: permissionVerdictPayload,
})
export const gitRequestFrame = frameBase.extend({ type: z.literal('git.request'), payload: gitRequestPayload })
export const projectScanFrame = frameBase.extend({ type: z.literal('project.scan'), payload: projectScanPayload })
export const claudeSettingsRequestFrame = frameBase.extend({
  type: z.literal('claude.settings.request'),
  payload: claudeSettingsRequestPayload,
})
export const sessionEndFrame = frameBase.extend({
  type: z.literal('session.end'),
  sessionId: requiredSessionId,
  payload: sessionEndPayload,
})
export const runnerUpdateFrame = frameBase.extend({ type: z.literal('runner.update'), payload: runnerUpdatePayload })

export const serverToRunnerFrame = z.discriminatedUnion('type', [
  helloAckFrame,
  heartbeatAckFrame,
  eventAckFrame,
  sessionStartFrame,
  sessionMessageFrame,
  sessionSlashFrame,
  sessionInterruptFrame,
  sessionSetModelFrame,
  sessionSetPermissionModeFrame,
  permissionVerdictFrame,
  gitRequestFrame,
  projectScanFrame,
  claudeSettingsRequestFrame,
  sessionEndFrame,
  runnerUpdateFrame,
  errorFrame,
])

export const RUNNER_TO_SERVER_FRAME_TYPES = [
  'hello',
  'heartbeat',
  'event',
  'delta',
  'session.started',
  'session.status',
  'session.stats',
  'session.diff',
  'session.ended',
  'git.result',
  'project.list',
  'claude.settings.result',
  'runner.config',
  'cmd.ack',
  'error',
] as const
export type RunnerToServerFrameType = (typeof RUNNER_TO_SERVER_FRAME_TYPES)[number]

export const SERVER_TO_RUNNER_FRAME_TYPES = [
  'hello.ack',
  'heartbeat.ack',
  'event.ack',
  'session.start',
  'session.message',
  'session.slash',
  'session.interrupt',
  'session.setModel',
  'session.setPermissionMode',
  'permission.verdict',
  'git.request',
  'project.scan',
  'claude.settings.request',
  'session.end',
  'runner.update',
  'error',
] as const
export type ServerToRunnerFrameType = (typeof SERVER_TO_RUNNER_FRAME_TYPES)[number]

/* ---------- Parse helpers ----------
 *
 * Unknown frame TYPES must be ignored, not rejected (additive-compatibility rule).
 * These helpers distinguish "valid envelope, type this catalog doesn't know" from
 * a genuinely malformed frame, so consumers can skip the former silently and
 * count the latter toward the malformed-frame close threshold (10 in 60 s → 4008).
 */

const frameEnvelope = frameBase.extend({ payload: z.unknown() })

export type FrameParseResult<TFrame> =
  | { ok: true; frame: TFrame }
  | { ok: false; reason: 'unknown-type'; type: string; frame: RelayFrame }
  | { ok: false; reason: 'malformed'; error: z.ZodError }

function parseFrame<TFrame>(
  input: unknown,
  union: typeof runnerToServerFrame | typeof serverToRunnerFrame,
  knownTypes: readonly string[],
): FrameParseResult<TFrame> {
  const parsed = union.safeParse(input)
  if (parsed.success) return { ok: true, frame: parsed.data as unknown as TFrame }
  const envelope = frameEnvelope.safeParse(input)
  if (envelope.success && !knownTypes.includes(envelope.data.type)) {
    return { ok: false, reason: 'unknown-type', type: envelope.data.type, frame: envelope.data as RelayFrame }
  }
  return { ok: false, reason: 'malformed', error: parsed.error }
}

/** Parse a frame arriving at the server (runner → server direction). */
export function parseRunnerFrame(input: unknown): FrameParseResult<RunnerToServerFrame> {
  return parseFrame(input, runnerToServerFrame, RUNNER_TO_SERVER_FRAME_TYPES)
}

/** Parse a frame arriving at the runner (server → runner direction). */
export function parseServerFrame(input: unknown): FrameParseResult<ServerToRunnerFrame> {
  return parseFrame(input, serverToRunnerFrame, SERVER_TO_RUNNER_FRAME_TYPES)
}
