/**
 * Golden SDKMessage fixtures for the Claude adapter conformance tests (05 §12).
 *
 * Synthetic but shape-faithful to @anthropic-ai/claude-agent-sdk@0.3.202 (shapes read
 * from the installed sdk.d.ts). Builders — not recorded JSONL — so tests stay
 * deterministic; they double as protocol conformance inputs (02 §12).
 */

export const SESSION_ID = '3f2b5c1e-0000-4000-8000-00000000abcd'

let uuidCounter = 0
export function nextUuid(): string {
  uuidCounter += 1
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`
}

export interface UsageFixture {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export function usage(overrides: Partial<UsageFixture> = {}): UsageFixture {
  return {
    input_tokens: 120,
    output_tokens: 45,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 60,
    ...overrides,
  }
}

/* ---------- system ---------- */

export function initMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    uuid: nextUuid(),
    session_id: SESSION_ID,
    apiKeySource: 'temporary',
    claude_code_version: '2.1.202',
    cwd: '/home/dev/proj',
    tools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Task'],
    mcp_servers: [],
    model: 'claude-sonnet-4-5',
    permissionMode: 'default',
    slash_commands: ['clear', 'compact', 'context', 'usage'],
    output_style: 'default',
    skills: [],
    plugins: [],
    ...overrides,
  }
}

export function compactBoundary(preTokens: number, trigger: 'manual' | 'auto' = 'auto') {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: nextUuid(),
    session_id: SESSION_ID,
    compact_metadata: { trigger, pre_tokens: preTokens },
  }
}

export function informational(level: string, content: string) {
  return {
    type: 'system',
    subtype: 'informational',
    level,
    content,
    uuid: nextUuid(),
    session_id: SESSION_ID,
  }
}

export function permissionDenied(toolName: string, toolUseId: string, reason: string) {
  return {
    type: 'system',
    subtype: 'permission_denied',
    tool_name: toolName,
    tool_use_id: toolUseId,
    decision_reason_type: 'rule',
    decision_reason: reason,
    message: `Denied by rule: ${reason}`,
    uuid: nextUuid(),
    session_id: SESSION_ID,
  }
}

export function taskStarted(taskId: string, toolUseId: string, description: string) {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    description,
    subagent_type: 'explorer',
    uuid: nextUuid(),
    session_id: SESSION_ID,
  }
}

export function taskProgress(
  taskId: string,
  toolUseId: string,
  opts: { totalTokens: number; toolUses: number; durationMs?: number; summary?: string },
) {
  return {
    type: 'system',
    subtype: 'task_progress',
    task_id: taskId,
    tool_use_id: toolUseId,
    description: 'working',
    usage: {
      total_tokens: opts.totalTokens,
      tool_uses: opts.toolUses,
      duration_ms: opts.durationMs ?? 0,
    },
    ...(opts.summary ? { summary: opts.summary } : {}),
    uuid: nextUuid(),
    session_id: SESSION_ID,
  }
}

/* ---------- stream events ---------- */

export function messageStart(u: UsageFixture = usage()) {
  return {
    type: 'stream_event',
    uuid: nextUuid(),
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    event: { type: 'message_start', message: { usage: u } },
  }
}

export function contentBlockStart(index: number, blockType: 'text' | 'thinking' | 'tool_use') {
  return {
    type: 'stream_event',
    uuid: nextUuid(),
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    event: {
      type: 'content_block_start',
      index,
      content_block:
        blockType === 'tool_use'
          ? { type: 'tool_use', id: 'toolu_stream', name: 'Bash' }
          : { type: blockType },
    },
  }
}

export function textDelta(index: number, text: string) {
  return {
    type: 'stream_event',
    uuid: nextUuid(),
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
  }
}

export function thinkingDelta(index: number, thinking: string) {
  return {
    type: 'stream_event',
    uuid: nextUuid(),
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } },
  }
}

export function contentBlockStop(index: number) {
  return {
    type: 'stream_event',
    uuid: nextUuid(),
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    event: { type: 'content_block_stop', index },
  }
}

export function messageDelta(outputTokens: number) {
  return {
    type: 'stream_event',
    uuid: nextUuid(),
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    event: { type: 'message_delta', usage: { output_tokens: outputTokens } },
  }
}

/* ---------- assistant / user ---------- */

export interface ToolUseFixture {
  id: string
  name: string
  input: Record<string, unknown>
}

export function assistantMessage(opts: {
  id?: string
  text?: string
  thinking?: string
  toolUses?: ToolUseFixture[]
  usage?: UsageFixture
  parentToolUseId?: string | null
  error?: string
}): Record<string, unknown> {
  const content: unknown[] = []
  if (opts.thinking !== undefined) content.push({ type: 'thinking', thinking: opts.thinking })
  if (opts.text !== undefined) content.push({ type: 'text', text: opts.text })
  for (const tu of opts.toolUses ?? []) content.push({ type: 'tool_use', ...tu })
  return {
    type: 'assistant',
    uuid: nextUuid(),
    session_id: SESSION_ID,
    parent_tool_use_id: opts.parentToolUseId ?? null,
    ...(opts.error ? { error: opts.error } : {}),
    message: {
      id: opts.id ?? `msg_${nextUuid().slice(-12)}`,
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content,
      usage: opts.usage ?? usage(),
      stop_reason: (opts.toolUses ?? []).length > 0 ? 'tool_use' : 'end_turn',
    },
  }
}

export function userToolResult(toolUseId: string, content: unknown, isError = false) {
  return {
    type: 'user',
    uuid: nextUuid(),
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    isSynthetic: true,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
    },
  }
}

/* ---------- results ---------- */

export function resultSuccess(opts: { result?: string; costUsd?: number; numTurns?: number; usage?: UsageFixture; terminalReason?: string } = {}) {
  return {
    type: 'result',
    subtype: 'success',
    uuid: nextUuid(),
    session_id: SESSION_ID,
    duration_ms: 5000,
    duration_api_ms: 4200,
    is_error: false,
    num_turns: opts.numTurns ?? 1,
    result: opts.result ?? 'Done.',
    stop_reason: 'end_turn',
    total_cost_usd: opts.costUsd ?? 0.0421,
    usage: opts.usage ?? usage(),
    modelUsage: {},
    permission_denials: [],
    ...(opts.terminalReason ? { terminal_reason: opts.terminalReason } : {}),
  }
}

export function resultError(
  subtype:
    | 'error_max_turns'
    | 'error_during_execution'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries',
  opts: { errors?: string[]; numTurns?: number; costUsd?: number; usage?: UsageFixture; terminalReason?: string } = {},
) {
  return {
    type: 'result',
    subtype,
    uuid: nextUuid(),
    session_id: SESSION_ID,
    duration_ms: 9000,
    duration_api_ms: 8000,
    is_error: true,
    num_turns: opts.numTurns ?? 3,
    stop_reason: null,
    total_cost_usd: opts.costUsd ?? 0.9,
    usage: opts.usage ?? usage(),
    modelUsage: {},
    permission_denials: [],
    errors: opts.errors ?? [`${subtype} happened`],
    ...(opts.terminalReason ? { terminal_reason: opts.terminalReason } : {}),
  }
}

/* ---------- hook inputs ---------- */

export function preToolUseInput(toolName: string, toolUseId: string, input: Record<string, unknown>) {
  return {
    hook_event_name: 'PreToolUse' as const,
    session_id: SESSION_ID,
    transcript_path: '/tmp/t.jsonl',
    cwd: '/home/dev/proj',
    tool_name: toolName,
    tool_input: input,
    tool_use_id: toolUseId,
  }
}

export function postToolUseInput(
  toolName: string,
  toolUseId: string,
  response: unknown,
  durationMs?: number,
  agentId?: string,
) {
  return {
    hook_event_name: 'PostToolUse' as const,
    session_id: SESSION_ID,
    transcript_path: '/tmp/t.jsonl',
    cwd: '/home/dev/proj',
    tool_name: toolName,
    tool_input: {},
    tool_response: response,
    tool_use_id: toolUseId,
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
  }
}

export function postToolUseFailureInput(
  toolName: string,
  toolUseId: string,
  error: string,
  durationMs?: number,
) {
  return {
    hook_event_name: 'PostToolUseFailure' as const,
    session_id: SESSION_ID,
    transcript_path: '/tmp/t.jsonl',
    cwd: '/home/dev/proj',
    tool_name: toolName,
    tool_input: {},
    tool_use_id: toolUseId,
    error,
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
  }
}
