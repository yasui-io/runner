/**
 * THE §5 MAPPING TABLE — `SDKMessage` → `AdapterOutput` (wire events / deltas /
 * status / stats / tool-finished). Every SDKMessage variant is handled or explicitly
 * default-ignored at debug; unknown future variants never throw.
 *
 * Type-safety note (documented deviation): the installed SDK (0.3.202) declares
 * `SDKMessage` against types imported from the `@anthropic-ai/sdk` / MCP peer packages
 * (BetaMessage, BetaRawMessageStreamEvent, MessageParam) which are not installed, and
 * it references `SDKConversationResetMessage` in the union without ever declaring it —
 * under `skipLibCheck` the whole `SDKMessage` union therefore collapses to `any`
 * (verified with a tsc probe). This module consequently defines its own structural
 * types for the message shapes it consumes and treats incoming messages as `unknown`,
 * narrowing by `type`/`subtype` — which also satisfies the "unknown variants must not
 * throw" rule for free.
 *
 * Verified against the installed SDK (0.3.202) — the 05 "Verify against SDK" items:
 *  - thinking deltas: the Anthropic Messages stream shape is
 *    `content_block_delta` with `delta: { type: 'thinking_delta', thinking: string }`
 *    (the SDK's own `SDKThinkingTokensMessage` doc comment confirms `thinking_delta`
 *    exists on this stream); the whole-message fallback below still covers streams
 *    where thinking deltas never arrive.
 *  - `SDKToolProgressMessage` carries only `{ tool_use_id, tool_name,
 *    parent_tool_use_id, elapsed_time_seconds, task_id? }` — NO incremental Bash
 *    output — so `delta` target `'tool-output'` stays reserved (nothing to wire).
 *  - `SDKTaskStartedMessage` = `{ task_id, tool_use_id?, description, subagent_type?,
 *    prompt?, task_type?, skip_transcript? }`; `SDKTaskProgressMessage` =
 *    `{ task_id, tool_use_id?, description, usage: { total_tokens, tool_uses,
 *    duration_ms }, last_tool_name?, summary? }` — correlated to the Agent tool_use
 *    by `tool_use_id` (with a `task_id` map as fallback).
 *  - child-message forwarding: with `forwardSubagentText: false` the SDK still emits
 *    subagent tool_use/tool_result blocks with `parent_tool_use_id` set ("enough for
 *    a heartbeat counter" — Options.forwardSubagentText doc), so the §5.7 toolUses/
 *    tokens enrichment works.
 */

import type {
  AgentRun,
  SessionStatus,
  TodoItem,
  ToolCall,
  WireSessionEvent,
} from '@yasui.io/runner-protocol'
import { RELAY_LIMITS } from '@yasui.io/runner-protocol'
import type { AdapterOutput, PermissionVerdict } from '../harness-adapter'
import { ContextMeter, type UsageLike } from './context-meter'
import { type AdapterLogger, firstLine, noopLogger, newEventId, nowIso, truncate } from './support'
import { TaskTracker, isTaskTool } from './task-tracker'
import {
  ERROR_TEXT_MAX,
  coerceToolResponse,
  isMutatingTool,
  summarizeToolInput,
  summarizeToolOutput,
} from './tool-summary'

/* ---------- structural shapes for the SDK messages we consume ---------- */

interface UsageShape extends UsageLike {}

interface TextBlock {
  type: 'text'
  text: string
}
interface ThinkingBlock {
  type: 'thinking'
  thinking: string
}
interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}
interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content?: unknown
  is_error?: boolean
}
type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | { type: string }

interface AssistantMessageShape {
  id?: string
  model?: string
  content?: ContentBlock[]
  usage?: UsageShape
  stop_reason?: string | null
}

interface AssistantMsg {
  type: 'assistant'
  message: AssistantMessageShape
  parent_tool_use_id: string | null
  error?: string
}

interface UserMsg {
  type: 'user'
  message?: { role?: string; content?: unknown }
  parent_tool_use_id?: string | null
  isReplay?: boolean
  isSynthetic?: boolean
}

/** Raw Anthropic Messages stream events (structural — see type-safety note above). */
type RawStreamEvent =
  | { type: 'message_start'; message?: { usage?: UsageShape } }
  | {
      type: 'content_block_start'
      index: number
      content_block?: { type?: string; id?: string; name?: string }
    }
  | {
      type: 'content_block_delta'
      index: number
      delta?: {
        type?: string
        text?: string
        thinking?: string
        partial_json?: string
        signature?: string
      }
    }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; usage?: UsageShape }
  | { type: 'message_stop' }
  | { type: string }

interface StreamEventMsg {
  type: 'stream_event'
  event?: RawStreamEvent
  parent_tool_use_id?: string | null
}

interface ResultMsg {
  type: 'result'
  subtype?: string
  is_error?: boolean
  num_turns?: number
  result?: string
  total_cost_usd?: number
  usage?: UsageShape
  errors?: string[]
  terminal_reason?: string
  session_id?: string
}

interface SystemMsg {
  type: 'system'
  subtype?: string
  [key: string]: unknown
}

/* ---------- directives (translation-free lifecycle facts for the adapter) ---------- */

export interface InitDirective {
  type: 'init'
  harnessSessionId: string
  model: string
  permissionMode: string
  slashCommands: string[]
  tools: string[]
  cwd: string
  claudeCodeVersion: string
  /** true when this init belongs to a transparent restart (no connect event emitted). */
  suppressed: boolean
}

export interface ResultDirective {
  type: 'result'
  subtype: string
  isError: boolean
  terminalReason: string | null
  /** joined errors[] for error subtypes (adapter uses it for the give-up path) */
  errorText: string | null
}

export interface FatalDirective {
  type: 'fatal'
  errorText: string
}

export type MapperDirective = InitDirective | ResultDirective | FatalDirective

/* ---------- internal state records ---------- */

interface OpenBlock {
  kind: 'assistant' | 'thinking'
  eventId: string
  at: string
  /** text accumulated in the CURRENT event id (reset on rollover) */
  text: string
  /** total chars across rollovers (reconciliation compare) */
  totalText: string
  rolledOver: boolean
  startedAtMs: number
  lastFlushAt: number
  flushTimer: ReturnType<typeof setTimeout> | null
}

interface ToolRecord {
  eventId: string
  at: string
  call: ToolCall
  /** shared calls array when part of a tool-group */
  groupCalls: ToolCall[] | null
  startedAtMs: number
  finished: boolean
}

interface AgentRecord {
  eventId: string
  at: string
  run: AgentRun
  seenMsgIds: Set<string>
  childToolUses: number
  childTokens: number
  progressToolUses: number
  progressTokens: number
  finished: boolean
}

export const AUTH_REVOKED_TEXT = 'Inference authorization ended — the session key was revoked.'
export const INTERRUPTED_ERROR_TEXT = 'Interrupted'
export const AGENT_TOOL_NAMES = new Set(['Agent', 'Task'])

function n(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function jsonOneLine(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '{}'
  } catch {
    return '[unserializable]'
  }
}

export interface MessageMapperOptions {
  sessionId: string
  cwd: string
  maxTurns: number
  maxBudgetUsd: number
  emit(out: AdapterOutput): void
  log?: AdapterLogger
  /** injectable for deterministic golden tests */
  newId?: () => string
}

export class MessageMapper {
  private readonly emit: (out: AdapterOutput) => void
  private readonly log: AdapterLogger
  private readonly newId: () => string

  readonly meter = new ContextMeter()
  private readonly tracker: TaskTracker

  private streamBlocks = new Map<number, OpenBlock>()
  /** content indices already streamed for the current message (skip re-emission) */
  private handledIndices = new Set<number>()
  private firstToolBlockSeen = false

  private toolRecords = new Map<string, ToolRecord>()
  private agentRecords = new Map<string, AgentRecord>()
  private taskIdToToolUse = new Map<string, string>()
  private startedAtByToolUse = new Map<string, number>()

  /* §8 stats — accumulated across query() restarts; result reconciliation wins */
  private statsBase = { tokensIn: 0, tokensOut: 0, cacheRead: 0, turns: 0, cost: 0 }
  private inQuery = { tokensIn: 0, tokensOut: 0, cacheRead: 0, turns: 0, cost: 0 }
  private statsSeenMessageIds = new Set<string>()
  private processedAssistantMsgIds = new Set<string>()
  private statsDirty = false
  private statsLastEmit = 0
  private statsTimer: ReturnType<typeof setTimeout> | null = null

  private suppressNextInit = false
  private todoEventAt: string | null = null
  private lastSuccessText: string | null = null
  private disposed = false

  constructor(private readonly opts: MessageMapperOptions) {
    this.emit = opts.emit
    this.log = opts.log ?? noopLogger
    this.newId = opts.newId ?? newEventId
    this.tracker = new TaskTracker(opts.sessionId)
  }

  get lastSuccessResultText(): string | null {
    return this.lastSuccessText
  }

  /* ---------------------------------------------------------------- messages */

  handleMessage(msg: unknown): MapperDirective | null {
    const m = msg as { type?: unknown }
    switch (m.type) {
      case 'stream_event':
        this.handleStreamEvent(msg as StreamEventMsg)
        return null
      case 'assistant':
        return this.handleAssistant(msg as AssistantMsg)
      case 'user':
        this.handleUser(msg as UserMsg)
        return null
      case 'result':
        return this.handleResult(msg as ResultMsg)
      case 'system':
        return this.handleSystem(msg as SystemMsg)
      case 'tool_progress':
        // Verified: no incremental output payload — 'tool-output' deltas stay reserved.
        this.log.debug({ sessionId: this.opts.sessionId }, 'tool_progress ignored (v1)')
        return null
      default:
        // SDKStatusMessage, hook lifecycle, tool_use_summary, task_notification,
        // rate-limit, mirror-error, auth_status, … and unknown future variants.
        this.log.debug(
          { sessionId: this.opts.sessionId, msgType: String(m.type) },
          'unhandled SDK message ignored (v1)',
        )
        return null
    }
  }

  /* --------------------------------------------------------- stream events */

  private handleStreamEvent(msg: StreamEventMsg): void {
    // stream events are main-session only (research: parent_tool_use_id always null);
    // ignore defensively if a future SDK forwards subagent streams.
    if (msg.parent_tool_use_id) return
    const ev = msg.event
    if (!ev || typeof ev !== 'object') return
    switch (ev.type) {
      case 'message_start': {
        this.finalizeAllOpenBlocks()
        this.handledIndices.clear()
        this.firstToolBlockSeen = false
        this.emitStatus('streaming')
        const usage = (ev as { message?: { usage?: UsageShape } }).message?.usage
        if (usage) {
          this.meter.onMessageStart(usage)
          this.markStatsDirty()
        }
        return
      }
      case 'content_block_start': {
        const e = ev as Extract<RawStreamEvent, { type: 'content_block_start' }>
        const blockType = e.content_block?.type
        if (blockType === 'text') this.openBlock(e.index, 'assistant')
        else if (blockType === 'thinking') this.openBlock(e.index, 'thinking')
        else if (blockType === 'tool_use') {
          if (!this.firstToolBlockSeen) {
            this.firstToolBlockSeen = true
            this.emitStatus('working')
          }
        } else {
          this.log.debug({ blockType }, 'content_block_start ignored')
        }
        return
      }
      case 'content_block_delta': {
        const e = ev as Extract<RawStreamEvent, { type: 'content_block_delta' }>
        const delta = e.delta
        if (!delta) return
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          this.appendText(e.index, 'assistant', delta.text)
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          this.appendText(e.index, 'thinking', delta.thinking)
        }
        // input_json_delta / signature_delta: not surfaced
        return
      }
      case 'content_block_stop': {
        const e = ev as Extract<RawStreamEvent, { type: 'content_block_stop' }>
        const block = this.streamBlocks.get(e.index)
        if (block) {
          this.finalizeBlock(block)
          this.streamBlocks.delete(e.index)
        }
        return
      }
      case 'message_delta': {
        // context meter input only (§5 table / §10)
        const usage = (ev as { usage?: UsageShape }).usage
        if (usage) {
          this.meter.onStreamingOutputTokens(usage.output_tokens)
          this.markStatsDirty()
        }
        return
      }
      case 'message_stop':
        return
      default:
        this.log.debug({ eventType: String(ev.type) }, 'stream_event ignored')
    }
  }

  private openBlock(index: number, kind: 'assistant' | 'thinking'): OpenBlock {
    const existing = this.streamBlocks.get(index)
    if (existing) return existing
    const now = Date.now()
    const block: OpenBlock = {
      kind,
      eventId: this.newId(),
      at: nowIso(),
      text: '',
      totalText: '',
      rolledOver: false,
      startedAtMs: now,
      lastFlushAt: now,
      flushTimer: null,
    }
    this.streamBlocks.set(index, block)
    this.handledIndices.add(index)
    this.emitEvent(
      kind === 'assistant'
        ? { id: block.eventId, at: block.at, kind: 'assistant', text: '', streaming: true }
        : { id: block.eventId, at: block.at, kind: 'thinking', text: '', streaming: true },
    )
    return block
  }

  private appendText(index: number, kind: 'assistant' | 'thinking', chunk: string): void {
    if (chunk === '') return
    // Lazily open on a missed content_block_start (restart resilience).
    const block = this.streamBlocks.get(index) ?? this.openBlock(index, kind)
    let remaining = chunk
    while (remaining.length > 0) {
      let piece = remaining
      if (Buffer.byteLength(piece, 'utf8') > RELAY_LIMITS.maxDeltaTextBytes) {
        // split oversized chunks; 2 048 chars ≤ 8 192 bytes even at 4 B/char
        piece = remaining.slice(0, 2048)
      }
      this.emit({
        type: 'delta',
        delta: {
          target: block.kind,
          eventId: block.eventId,
          offset: block.text.length, // cumulative char position (02 §6)
          text: piece,
        },
      })
      block.text += piece
      block.totalText += piece
      remaining = remaining.slice(piece.length)
      if (Buffer.byteLength(block.text, 'utf8') > RELAY_LIMITS.eventRolloverBytes) {
        this.rolloverBlock(block)
      }
    }
    this.scheduleFlush(block)
  }

  /** 16 KiB rollover: finalize (final: true) and continue in a fresh event id (02 §6). */
  private rolloverBlock(block: OpenBlock): void {
    this.clearFlushTimer(block)
    this.emitBlockRevision(block, { streaming: false, final: true })
    block.eventId = this.newId()
    block.at = nowIso()
    block.text = ''
    block.rolledOver = true
    block.lastFlushAt = Date.now()
    // open the continuation event immediately so deltas land on a known snapshot
    this.emitBlockRevision(block, { streaming: true })
  }

  private scheduleFlush(block: OpenBlock): void {
    if (block.flushTimer) return
    const delay = Math.max(0, block.lastFlushAt + RELAY_LIMITS.deltaFlushMs - Date.now())
    block.flushTimer = setTimeout(() => {
      block.flushTimer = null
      block.lastFlushAt = Date.now()
      this.emitBlockRevision(block, { streaming: true })
    }, delay)
    block.flushTimer.unref?.()
  }

  private clearFlushTimer(block: OpenBlock): void {
    if (block.flushTimer) {
      clearTimeout(block.flushTimer)
      block.flushTimer = null
    }
  }

  private emitBlockRevision(
    block: OpenBlock,
    opts: { streaming: boolean; final?: boolean; durationMs?: number },
  ): void {
    if (block.kind === 'assistant') {
      this.emitEvent({
        id: block.eventId,
        at: block.at,
        kind: 'assistant',
        text: block.text,
        streaming: opts.streaming,
        ...(opts.final ? { final: true } : {}),
      })
    } else {
      this.emitEvent({
        id: block.eventId,
        at: block.at,
        kind: 'thinking',
        text: block.text,
        streaming: opts.streaming,
        ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
        ...(opts.final ? { final: true } : {}),
      })
    }
  }

  private finalizeBlock(block: OpenBlock, authoritativeText?: string): void {
    this.clearFlushTimer(block)
    if (
      authoritativeText !== undefined &&
      !block.rolledOver &&
      authoritativeText !== block.totalText
    ) {
      // complete assistant message wins for events that never rolled over (§5)
      block.text = authoritativeText
      block.totalText = authoritativeText
    }
    this.emitBlockRevision(block, {
      streaming: false,
      final: true,
      ...(block.kind === 'thinking' ? { durationMs: Date.now() - block.startedAtMs } : {}),
    })
  }

  private finalizeAllOpenBlocks(): void {
    for (const block of this.streamBlocks.values()) this.finalizeBlock(block)
    this.streamBlocks.clear()
  }

  /* ---------------------------------------------------- assistant messages */

  private handleAssistant(msg: AssistantMsg): MapperDirective | null {
    if (msg.error) return this.handleAssistantError(msg.error)
    if (msg.parent_tool_use_id) {
      this.handleChildAssistant(msg)
      return null
    }

    const message = msg.message ?? {}
    const content = Array.isArray(message.content) ? message.content : []
    const messageId = str(message.id)
    // Parallel tool calls can repeat the same message id (sdk-sessions §5) — never
    // re-emit text/thinking for a repeated id.
    const repeatedMessage = messageId !== '' && this.processedAssistantMsgIds.has(messageId)
    if (messageId) this.processedAssistantMsgIds.add(messageId)

    const toolBlocks: ToolUseBlock[] = []
    content.forEach((rawBlock, index) => {
      const block = rawBlock as ContentBlock
      if (block.type === 'text' || block.type === 'thinking') {
        if (repeatedMessage) return
        const text =
          block.type === 'text' ? str((block as TextBlock).text) : str((block as ThinkingBlock).thinking)
        const open = this.streamBlocks.get(index)
        if (open) {
          // final revision of the still-open event with authoritative text
          this.finalizeBlock(open, text)
          this.streamBlocks.delete(index)
        } else if (!this.handledIndices.has(index)) {
          // deltas never arrived (e.g. thinking streams without thinking_delta,
          // or a restart dropped partials) — emit the event whole (§5 fallback)
          this.emitEvent(
            block.type === 'text'
              ? { id: this.newId(), at: nowIso(), kind: 'assistant', text }
              : { id: this.newId(), at: nowIso(), kind: 'thinking', text },
          )
          this.handledIndices.add(index)
        }
        return
      }
      if (block.type === 'tool_use') {
        const tool = block as ToolUseBlock
        // dedupe repeated tool_use blocks by their (globally unique) toolu_ id
        if (this.toolRecords.has(tool.id) || this.agentRecords.has(tool.id)) return
        const input = (tool.input ?? {}) as Record<string, unknown>
        if (AGENT_TOOL_NAMES.has(tool.name)) {
          this.createAgentRun(tool.id, input)
          return
        }
        if (isTaskTool(tool.name)) {
          const snapshot = this.tracker.handleToolUse(tool.name, tool.id, input)
          if (snapshot) this.emitTodoSnapshot(snapshot)
          return
        }
        toolBlocks.push({ ...tool, input })
        return
      }
      this.log.debug({ blockType: block.type }, 'assistant content block ignored')
    })

    // any stream blocks left without a matching content entry: close them out
    this.finalizeAllOpenBlocks()
    this.handledIndices.clear()

    if (toolBlocks.length > 0) {
      this.emitToolEvents(toolBlocks)
      if (!this.firstToolBlockSeen) {
        // partial messages missed (no stream_event flow) — still transition
        this.firstToolBlockSeen = true
        this.emitStatus('working')
      }
    }

    if (messageId && message.usage) {
      this.accumulateUsage(messageId, message.usage)
      this.meter.commitAssistantUsage(messageId, message.usage)
      this.markStatsDirty()
    }
    return null
  }

  /** §9 assistant `error` field handling. */  private handleAssistantError(error: string): MapperDirective | null {
    if (error === 'authentication_failed' || error === 'billing_error') {
      this.emitEvent({ id: this.newId(), at: nowIso(), kind: 'error', text: AUTH_REVOKED_TEXT })
      this.emitStatus('failed')
      return { type: 'fatal', errorText: AUTH_REVOKED_TEXT }
    }
    if (error === 'rate_limit' || error === 'overloaded' || error === 'server_error') {
      // warning only — no adapter retry; a following error_during_execution result
      // (if the turn actually failed) is covered by the §9 restart row.
      this.emitEvent({
        id: this.newId(),
        at: nowIso(),
        kind: 'system',
        variant: 'info',
        text: `Upstream inference error (${error}) — the harness may retry.`,
      })
      return null
    }
    this.log.debug({ error }, 'assistant error value ignored (v1)')
    return null
  }

  /** §5.7 — child messages enrich the parent AgentRun; no transcript event. */
  private handleChildAssistant(msg: AssistantMsg): void {
    const rec = this.agentRecords.get(msg.parent_tool_use_id as string)
    const message = msg.message ?? {}
    const messageId = str(message.id)
    if (messageId && message.usage) {
      // child usage counts toward session stats too (§8 "every complete assistant
      // message"); the next result reconciliation wins regardless.
      this.accumulateUsage(messageId, message.usage)
      this.markStatsDirty()
    }
    if (!rec || rec.finished) return
    if (messageId) {
      if (rec.seenMsgIds.has(messageId)) return
      rec.seenMsgIds.add(messageId)
    }
    const content = Array.isArray(message.content) ? message.content : []
    rec.childToolUses += content.filter((b) => (b as ContentBlock).type === 'tool_use').length
    rec.childTokens += n(message.usage?.output_tokens)
    this.refreshAgentCounters(rec)
    this.emitAgentEvent(rec)
  }

  /* ------------------------------------------------------------ tool events */

  private emitToolEvents(blocks: ToolUseBlock[]): void {
    const at = nowIso()
    const calls: ToolCall[] = blocks.map((block) => {
      const summary = summarizeToolInput(block.name, block.input, this.opts.cwd)
      return {
        id: block.id,
        name: block.name,
        summary: summary.summary,
        status: 'running' as const,
        ...(summary.input !== undefined ? { input: summary.input } : {}),
        ...(summary.diff !== undefined ? { diff: summary.diff } : {}),
      }
    })
    const eventId = this.newId()
    const group = calls.length > 1 ? calls : null
    blocks.forEach((block, i) => {
      this.toolRecords.set(block.id, {
        eventId,
        at,
        call: calls[i] as ToolCall,
        groupCalls: group,
        startedAtMs: this.startedAtByToolUse.get(block.id) ?? Date.now(),
        finished: false,
      })
    })
    if (group) {
      this.emitEvent({ id: eventId, at, kind: 'tool-group', calls: group.map((c) => ({ ...c })) })
    } else {
      this.emitEvent({ id: eventId, at, kind: 'tool', call: { ...(calls[0] as ToolCall) } })
    }
  }

  private emitToolRevision(rec: ToolRecord): void {
    if (rec.groupCalls) {
      this.emitEvent({
        id: rec.eventId,
        at: rec.at,
        kind: 'tool-group',
        calls: rec.groupCalls.map((c) => ({ ...c })),
        ...(rec.groupCalls.every((c) => c.status !== 'running') ? { final: true } : {}),
      })
    } else {
      this.emitEvent({
        id: rec.eventId,
        at: rec.at,
        kind: 'tool',
        call: { ...rec.call },
        ...(rec.call.status !== 'running' ? { final: true } : {}),
      })
    }
  }

  /* ------------------------------------------------------------------ hooks */

  /**
   * PreToolUse fires at step 1 of permission evaluation — before rules/mode/
   * canUseTool (§5.1). Never gates; records startedAt for calls that skip the dock.
   */
  handlePreToolUse(input: { tool_use_id?: string }): void {
    const id = str(input.tool_use_id)
    if (!id) return
    this.startedAtByToolUse.set(id, Date.now())
    const rec = this.toolRecords.get(id)
    if (rec && !rec.finished) rec.startedAtMs = Date.now()
  }

  handlePostToolUse(input: {
    tool_name?: string
    tool_use_id?: string
    tool_response?: unknown
    duration_ms?: number
    agent_id?: string
  }): void {
    const name = str(input.tool_name)
    const id = str(input.tool_use_id)
    if (!id) return

    if (!input.agent_id && isTaskTool(name)) {
      const snapshot = this.tracker.handleToolResult(id, input.tool_response)
      if (snapshot) this.emitTodoSnapshot(snapshot)
      return
    }

    const agentRec = this.agentRecords.get(id)
    if (agentRec) {
      this.finishAgentRun(agentRec, {
        status: 'success',
        result: truncate(coerceToolResponse(input.tool_response), 500),
        durationMs: input.duration_ms,
      })
      this.emit({ type: 'tool-finished', toolName: name, mutating: true })
      return
    }

    const rec = this.toolRecords.get(id)
    if (rec) {
      if (rec.finished) return
      rec.finished = true
      rec.call.status = 'success'
      rec.call.durationMs = input.duration_ms ?? Date.now() - rec.startedAtMs
      rec.call.output = summarizeToolOutput(name || rec.call.name, input.tool_response)
      this.emitToolRevision(rec)
      this.emit({ type: 'tool-finished', toolName: rec.call.name, mutating: isMutatingTool(rec.call.name) })
      return
    }

    // untracked completion (subagent-internal tools carry agent_id): still poke the
    // DiffWatcher — subagent edits change the tree like anything else.
    this.log.debug({ toolName: name, toolUseId: id }, 'PostToolUse for untracked tool call')
    if (name) this.emit({ type: 'tool-finished', toolName: name, mutating: isMutatingTool(name) })
  }

  handlePostToolUseFailure(input: {
    tool_name?: string
    tool_use_id?: string
    error?: string
    duration_ms?: number
    agent_id?: string
  }): void {
    const name = str(input.tool_name)
    const id = str(input.tool_use_id)
    if (!id) return
    const errorText = truncate(str(input.error), ERROR_TEXT_MAX)

    if (!input.agent_id && isTaskTool(name)) {
      this.tracker.handleToolFailure(id)
      return
    }

    const agentRec = this.agentRecords.get(id)
    if (agentRec) {
      this.finishAgentRun(agentRec, {
        status: 'error',
        result: truncate(errorText, 500),
        durationMs: input.duration_ms,
      })
      this.emit({ type: 'tool-finished', toolName: name, mutating: true })
      return
    }

    const rec = this.toolRecords.get(id)
    if (rec) {
      if (rec.finished) return
      rec.finished = true
      rec.call.status = 'error'
      rec.call.errorText = errorText
      rec.call.durationMs = input.duration_ms ?? Date.now() - rec.startedAtMs
      this.emitToolRevision(rec)
      this.emit({ type: 'tool-finished', toolName: rec.call.name, mutating: isMutatingTool(rec.call.name) })
      return
    }

    this.log.debug({ toolName: name, toolUseId: id }, 'PostToolUseFailure for untracked tool call')
    if (name) this.emit({ type: 'tool-finished', toolName: name, mutating: isMutatingTool(name) })
  }

  /**
   * §6 resolution path: verdict timestamps overwrite startedAt (durationMs excludes the
   * permission wait) and `updatedInput` re-summarizes the tool event so the transcript
   * shows what actually ran.
   */
  applyVerdictResolution(toolUseId: string, verdict: PermissionVerdict): void {
    this.startedAtByToolUse.set(toolUseId, Date.now())
    const rec = this.toolRecords.get(toolUseId)
    if (rec && !rec.finished) rec.startedAtMs = Date.now()
    if (verdict.behavior !== 'allow' || !verdict.updatedInput) return
    if (!rec || rec.finished) return
    const summary = summarizeToolInput(rec.call.name, verdict.updatedInput, this.opts.cwd)
    rec.call.summary = summary.summary
    if (summary.input !== undefined) rec.call.input = summary.input
    else delete rec.call.input
    if (summary.diff !== undefined) rec.call.diff = summary.diff
    else delete rec.call.diff
    this.emitToolRevision(rec)
  }

  /* -------------------------------------------------------------- user msgs */

  private handleUser(msg: UserMsg): void {
    // Our `user` transcript events originate control-plane-side (§5). Replays are
    // resume history — re-processing them would double-drive the task tracker.
    if (msg.isReplay) return
    if (msg.parent_tool_use_id) return
    const content = msg.message?.content
    if (!Array.isArray(content)) return
    for (const raw of content) {
      const block = raw as ToolResultBlock
      if (block.type !== 'tool_result' || !block.tool_use_id) continue
      const snapshot = this.tracker.handleToolResult(block.tool_use_id, block.content)
      if (snapshot) {
        this.emitTodoSnapshot(snapshot)
        continue
      }
      // fallback completion when hooks missed (§5 table)
      const rec = this.toolRecords.get(block.tool_use_id)
      if (rec && !rec.finished) {
        rec.finished = true
        if (block.is_error) {
          rec.call.status = 'error'
          rec.call.errorText = truncate(coerceToolResponse(block.content), ERROR_TEXT_MAX)
        } else {
          rec.call.status = 'success'
          rec.call.output = summarizeToolOutput(rec.call.name, block.content)
        }
        rec.call.durationMs = Date.now() - rec.startedAtMs
        this.emitToolRevision(rec)
        this.emit({
          type: 'tool-finished',
          toolName: rec.call.name,
          mutating: isMutatingTool(rec.call.name),
        })
        continue
      }
      const agentRec = this.agentRecords.get(block.tool_use_id)
      if (agentRec && !agentRec.finished) {
        this.finishAgentRun(agentRec, {
          status: block.is_error ? 'error' : 'success',
          result: truncate(coerceToolResponse(block.content), 500),
        })
      }
    }
  }

  /* ---------------------------------------------------------------- results */

  private handleResult(msg: ResultMsg): MapperDirective | null {
    const subtype = str(msg.subtype) || 'success'
    // Swallow the init-nudge echo: the shouldQuery:false message the adapter pushes
    // to un-gate the init handshake (input-queue.ts) yields an immediate zero-turn
    // empty success result — not a real turn; it must not touch status or stats.
    // Aborted zero-turn results (terminal_reason aborted_*) still flow through.
    if (
      subtype === 'success' &&
      n(msg.num_turns) === 0 &&
      str(msg.result) === '' &&
      !str(msg.terminal_reason).startsWith('aborted')
    ) {
      this.log.debug({ sessionId: this.opts.sessionId }, 'zero-turn nudge result swallowed')
      return null
    }
    // §8: result usage/cost reconciliation — result wins over the accumulators
    // (values are cumulative per query(); base carries prior query() runs).
    if (msg.usage) {
      this.inQuery.tokensIn = n(msg.usage.input_tokens)
      this.inQuery.tokensOut = n(msg.usage.output_tokens)
      this.inQuery.cacheRead = n(msg.usage.cache_read_input_tokens)
    }
    this.inQuery.cost = n(msg.total_cost_usd)
    this.inQuery.turns = n(msg.num_turns)
    this.emitStatsNow()

    const terminalReason = str(msg.terminal_reason) || null
    const errors = Array.isArray(msg.errors) ? msg.errors.map((e) => String(e)) : []
    const errorText = errors.length ? errors.join('\n') : null

    if (terminalReason === 'aborted_streaming' || terminalReason === 'aborted_tools') {
      // treat as interrupt — no error event (05 §9 terminal_reason mapping)
      this.interruptOpenWork()
      this.emitStatus('awaiting-input')
      return { type: 'result', subtype, isError: msg.is_error === true, terminalReason, errorText }
    }
    if (terminalReason === 'prompt_too_long') {
      this.emitEvent({
        id: this.newId(),
        at: nowIso(),
        kind: 'error',
        text: 'Context window is full — send /compact to summarize the conversation.',
      })
      this.emitStatus('awaiting-input')
      return { type: 'result', subtype, isError: msg.is_error === true, terminalReason, errorText }
    }

    switch (subtype) {
      case 'success':
        this.lastSuccessText = str(msg.result) || null
        this.emitStatus('awaiting-input')
        break
      case 'error_max_turns':
        this.emitEvent({
          id: this.newId(),
          at: nowIso(),
          kind: 'system',
          variant: 'info',
          text: `Turn limit (${this.opts.maxTurns}) reached — send a message to continue.`,
        })
        this.emitStatus('awaiting-input')
        break
      case 'error_max_budget_usd':
        this.emitEvent({
          id: this.newId(),
          at: nowIso(),
          kind: 'system',
          variant: 'info',
          text: `Budget limit ($${this.opts.maxBudgetUsd}) reached — send a message to continue.`,
        })
        this.emitStatus('awaiting-input')
        break
      case 'error_during_execution':
      case 'error_max_structured_output_retries':
        this.emitEvent({
          id: this.newId(),
          at: nowIso(),
          kind: 'error',
          text: errorText ?? `Claude Code failed (${subtype}).`,
        })
        // status stays as-is: the adapter retries once with resume (§9); it emits
        // 'failed' itself on the give-up path.
        break
      default:
        this.log.debug({ subtype }, 'unknown result subtype — treated as informational')
    }
    return { type: 'result', subtype, isError: msg.is_error === true, terminalReason, errorText }
  }

  /* ---------------------------------------------------------------- system */

  private handleSystem(msg: SystemMsg): MapperDirective | null {
    switch (msg.subtype) {
      case 'init': {
        const suppressed = this.suppressNextInit
        this.suppressNextInit = false
        const model = str(msg.model)
        const cwd = str(msg.cwd)
        if (!suppressed) {
          this.emitEvent({
            id: this.newId(),
            at: nowIso(),
            kind: 'system',
            variant: 'connect',
            text: `Claude Code ${str(msg.claude_code_version)} · ${model} · ${cwd}`,
          })
          this.emitStatus('idle')
        }
        return {
          type: 'init',
          harnessSessionId: str(msg.session_id),
          model,
          permissionMode: str(msg.permissionMode),
          slashCommands: Array.isArray(msg.slash_commands) ? msg.slash_commands.map(String) : [],
          tools: Array.isArray(msg.tools) ? msg.tools.map(String) : [],
          cwd,
          claudeCodeVersion: str(msg.claude_code_version),
          suppressed,
        }
      }
      case 'compact_boundary': {
        const meta = (msg.compact_metadata ?? {}) as { trigger?: unknown; pre_tokens?: unknown }
        const preTokens = n(meta.pre_tokens)
        this.emitEvent({
          id: this.newId(),
          at: nowIso(),
          kind: 'system',
          variant: 'compaction',
          text: `Context compacted — ${preTokens} tokens summarized (${str(meta.trigger) || 'auto'})`,
        })
        this.meter.onCompactBoundary(preTokens)
        this.markStatsDirty()
        return null
      }
      case 'informational': {
        const level = str(msg.level)
        if (level === 'notice' || level === 'warning') {
          this.emitEvent({
            id: this.newId(),
            at: nowIso(),
            kind: 'system',
            variant: 'info',
            text: str(msg.content),
          })
        }
        // level info | suggestion dropped (noise)
        return null
      }
      case 'permission_denied': {
        // auto-deny by rule/mode — no dock interaction; already resolved
        const at = nowIso()
        const toolName = str(msg.tool_name)
        this.emitEvent({
          id: this.newId(),
          at,
          kind: 'permission',
          tool: toolName,
          request: str(msg.message) || toolName,
          status: 'denied',
          toolUseId: str(msg.tool_use_id),
          input: {}, // the message carries no tool_input
          suggestions: [],
          expiresAt: at,
          ...(str(msg.agent_id) ? { agentId: str(msg.agent_id) } : {}),
          final: true,
        })
        const reason = str(msg.decision_reason)
        this.emitEvent({
          id: this.newId(),
          at,
          kind: 'system',
          variant: 'info',
          text: `Auto-denied ${toolName}${reason ? ` — ${reason}` : ''}`,
        })
        return null
      }
      case 'task_started': {
        const toolUseId = str(msg.tool_use_id)
        const taskId = str(msg.task_id)
        if (toolUseId && taskId) this.taskIdToToolUse.set(taskId, toolUseId)
        const rec = toolUseId ? this.agentRecords.get(toolUseId) : undefined
        if (rec && !rec.finished && !rec.run.task && str(msg.description)) {
          rec.run.task = firstLine(str(msg.description))
          this.emitAgentEvent(rec)
        }
        return null
      }
      case 'task_progress': {
        const toolUseId = str(msg.tool_use_id) || this.taskIdToToolUse.get(str(msg.task_id)) || ''
        const rec = toolUseId ? this.agentRecords.get(toolUseId) : undefined
        if (!rec || rec.finished) {
          this.log.debug({ taskId: str(msg.task_id) }, 'task_progress without matching AgentRun')
          return null
        }
        const usage = (msg.usage ?? {}) as {
          total_tokens?: unknown
          tool_uses?: unknown
          duration_ms?: unknown
        }
        rec.progressToolUses = Math.max(rec.progressToolUses, n(usage.tool_uses))
        rec.progressTokens = Math.max(rec.progressTokens, n(usage.total_tokens))
        if (n(usage.duration_ms) > 0) rec.run.durationMs = n(usage.duration_ms)
        this.refreshAgentCounters(rec)
        this.emitAgentEvent(rec)
        return null
      }
      default:
        // status, api_retry, hook_started/…, task_notification, task_updated,
        // thinking_tokens, session_state_changed, … — ignored in v1 (§5 table)
        this.log.debug({ subtype: str(msg.subtype) }, 'system message ignored (v1)')
        return null
    }
  }

  /* ------------------------------------------------------------- agent runs */

  private createAgentRun(toolUseId: string, input: Record<string, unknown>): void {
    const at = nowIso()
    // Verified fields: input.subagent_type (sdk-sessions §7); prompt/description are
    // best-effort with a raw-JSON fallback for the task line (05 §5.7 verify note).
    const task =
      firstLine(str(input.prompt) || str(input.description)) || truncate(jsonOneLine(input), 96)
    const run: AgentRun = {
      id: toolUseId,
      agentType: str(input.subagent_type) || 'agent',
      task,
      status: 'running',
      ...(str(input.model) ? { model: str(input.model) } : {}),
      toolUses: 0,
      tokens: 0,
    }
    const rec: AgentRecord = {
      eventId: this.newId(),
      at,
      run,
      seenMsgIds: new Set(),
      childToolUses: 0,
      childTokens: 0,
      progressToolUses: 0,
      progressTokens: 0,
      finished: false,
    }
    this.agentRecords.set(toolUseId, rec)
    this.emitAgentEvent(rec)
  }

  /** Progress summaries and child counting can both report — take the max (no double count). */
  private refreshAgentCounters(rec: AgentRecord): void {
    rec.run.toolUses = Math.max(rec.childToolUses, rec.progressToolUses)
    rec.run.tokens = Math.max(rec.childTokens, rec.progressTokens)
  }

  private finishAgentRun(
    rec: AgentRecord,
    opts: { status: 'success' | 'error'; result: string; durationMs?: number },
  ): void {
    if (rec.finished) return
    rec.finished = true
    rec.run.status = opts.status
    if (opts.result) rec.run.result = opts.result
    if (opts.durationMs !== undefined) rec.run.durationMs = opts.durationMs
    this.refreshAgentCounters(rec)
    this.emitAgentEvent(rec, true)
  }

  private emitAgentEvent(rec: AgentRecord, final = false): void {
    this.emitEvent({
      id: rec.eventId,
      at: rec.at,
      kind: 'agent',
      run: { ...rec.run },
      ...(final ? { final: true } : {}),
    })
  }

  /* ------------------------------------------------------------------ todos */

  private emitTodoSnapshot(todos: TodoItem[]): void {
    if (!this.todoEventAt) this.todoEventAt = nowIso()
    this.emitEvent({
      id: this.tracker.eventId, // stable per-session id: ev_todos_<sessionId> (§5.6)
      at: this.todoEventAt,
      kind: 'todo',
      todos: todos.map((t) => ({ ...t })),
    })
  }

  /* ------------------------------------------------------------- lifecycle */

  /** §9 interrupt semantics: close open streams, error running tools/agents. */
  interruptOpenWork(): void {
    this.finalizeAllOpenBlocks()
    for (const rec of this.toolRecords.values()) {
      if (rec.finished) continue
      rec.finished = true
      rec.call.status = 'error'
      rec.call.errorText = INTERRUPTED_ERROR_TEXT
      this.emitToolRevision(rec)
    }
    for (const rec of this.agentRecords.values()) {
      if (rec.finished) continue
      this.finishAgentRun(rec, { status: 'error', result: INTERRUPTED_ERROR_TEXT })
    }
  }

  /** `/clear` — context reset (§7/§10). */
  onContextCleared(): void {
    this.emitEvent({
      id: this.newId(),
      at: nowIso(),
      kind: 'system',
      variant: 'info',
      text: 'Context cleared',
    })
    this.meter.reset()
    this.emitStatsNow()
  }

  /** Transparent restart bookkeeping: re-base stats, swallow the resumed init (§2/§8). */
  noteQueryRestart(): void {
    this.suppressNextInit = true
    this.statsBase.tokensIn += this.inQuery.tokensIn
    this.statsBase.tokensOut += this.inQuery.tokensOut
    this.statsBase.cacheRead += this.inQuery.cacheRead
    this.statsBase.turns += this.inQuery.turns
    this.statsBase.cost += this.inQuery.cost
    this.inQuery = { tokensIn: 0, tokensOut: 0, cacheRead: 0, turns: 0, cost: 0 }
  }

  /** Exact window occupancy from Query.getContextUsage() — preferred over the formula (§10). */
  setExactContextTokens(totalTokens: number): void {
    this.meter.setExact(totalTokens)
    this.markStatsDirty()
  }

  dispose(): void {
    this.disposed = true
    if (this.statsTimer) {
      clearTimeout(this.statsTimer)
      this.statsTimer = null
    }
    for (const block of this.streamBlocks.values()) this.clearFlushTimer(block)
    this.streamBlocks.clear()
  }

  /* ------------------------------------------------------------------ stats */

  private accumulateUsage(messageId: string, usage: UsageShape): void {
    if (this.statsSeenMessageIds.has(messageId)) return
    this.statsSeenMessageIds.add(messageId)
    this.inQuery.tokensIn += n(usage.input_tokens)
    this.inQuery.tokensOut += n(usage.output_tokens)
    this.inQuery.cacheRead += n(usage.cache_read_input_tokens)
    // cache_creation_input_tokens feeds only the context meter; not a UI stat (§8)
  }

  emitStatsNow(): void {
    if (this.disposed) return
    if (this.statsTimer) {
      clearTimeout(this.statsTimer)
      this.statsTimer = null
    }
    this.statsDirty = false
    this.statsLastEmit = Date.now()
    this.emit({
      type: 'stats',
      stats: {
        tokensIn: this.statsBase.tokensIn + this.inQuery.tokensIn,
        tokensOut: this.statsBase.tokensOut + this.inQuery.tokensOut,
        cacheReadTokens: this.statsBase.cacheRead + this.inQuery.cacheRead,
        contextUsedTokens: this.meter.value(),
        costUsd: this.statsBase.cost + this.inQuery.cost,
        turns: this.statsBase.turns + this.inQuery.turns,
      },
    })
  }

  /** ≤1 stats frame per 2 s (droppable; §8). */
  private markStatsDirty(): void {
    if (this.disposed) return
    this.statsDirty = true
    const since = Date.now() - this.statsLastEmit
    if (since >= RELAY_LIMITS.deltaFlushMs) {
      this.emitStatsNow()
      return
    }
    if (this.statsTimer) return
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null
      if (this.statsDirty) this.emitStatsNow()
    }, RELAY_LIMITS.deltaFlushMs - since)
    this.statsTimer.unref?.()
  }

  /* ------------------------------------------------------------------ emit */

  private emitEvent(event: WireSessionEvent): void {
    this.emit({ type: 'event', event })
  }

  private emitStatus(status: SessionStatus): void {
    this.emit({ type: 'status', status })
  }
}
