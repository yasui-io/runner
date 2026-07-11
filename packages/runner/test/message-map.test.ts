/**
 * Golden tests for THE §5 mapping table (05 §12): synthetic SDKMessage sequences →
 * ordered AdapterOutput assertions. Fixtures in test/fixtures/claude/messages.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterOutput } from '../src/sessions/harness-adapter'
import {
  AUTH_REVOKED_TEXT,
  INTERRUPTED_ERROR_TEXT,
  MessageMapper,
} from '../src/sessions/claude/message-map'
import * as fx from './fixtures/claude/messages'

function makeMapper(overrides: { maxTurns?: number; maxBudgetUsd?: number } = {}) {
  const outputs: AdapterOutput[] = []
  let n = 0
  const mapper = new MessageMapper({
    sessionId: 'ags_test1',
    cwd: '/home/dev/proj',
    maxTurns: overrides.maxTurns ?? 80,
    maxBudgetUsd: overrides.maxBudgetUsd ?? 10,
    emit: (out) => outputs.push(out),
    newId: () => `ev_${String(++n).padStart(4, '0')}`,
  })
  return { mapper, outputs }
}

function events(outputs: AdapterOutput[]) {
  return outputs.filter((o) => o.type === 'event').map((o) => o.event)
}
function statuses(outputs: AdapterOutput[]) {
  return outputs.filter((o) => o.type === 'status').map((o) => o.status)
}
function deltas(outputs: AdapterOutput[]) {
  return outputs.filter((o) => o.type === 'delta').map((o) => o.delta)
}
function stats(outputs: AdapterOutput[]) {
  return outputs.filter((o) => o.type === 'stats').map((o) => o.stats)
}

describe('message-map: init', () => {
  it('emits connect system event + idle status and returns the init directive', () => {
    const { mapper, outputs } = makeMapper()
    const directive = mapper.handleMessage(fx.initMessage())
    expect(directive).toMatchObject({
      type: 'init',
      harnessSessionId: fx.SESSION_ID,
      model: 'claude-sonnet-4-5',
      permissionMode: 'default',
      slashCommands: ['clear', 'compact', 'context', 'usage'],
      tools: expect.arrayContaining(['Bash', 'Task']),
      cwd: '/home/dev/proj',
      suppressed: false,
    })
    const evs = events(outputs)
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({
      kind: 'system',
      variant: 'connect',
      text: 'Claude Code 2.1.202 · claude-sonnet-4-5 · /home/dev/proj',
    })
    expect(statuses(outputs)).toEqual(['idle'])
  })

  it('suppresses the connect event on a transparent-restart init', () => {
    const { mapper, outputs } = makeMapper()
    mapper.noteQueryRestart()
    const directive = mapper.handleMessage(fx.initMessage())
    expect(directive).toMatchObject({ type: 'init', suppressed: true })
    expect(events(outputs)).toHaveLength(0)
    expect(statuses(outputs)).toEqual([])
  })
})

describe('message-map: streaming text (delta flow)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('opens on content_block_start, streams deltas with cumulative offsets, 2s revision, final on assistant', () => {
    const { mapper, outputs } = makeMapper()
    mapper.handleMessage(fx.messageStart())
    expect(statuses(outputs)).toEqual(['streaming'])

    mapper.handleMessage(fx.contentBlockStart(0, 'text'))
    const opened = events(outputs)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ kind: 'assistant', text: '', streaming: true })
    const eventId = opened[0]!.id

    mapper.handleMessage(fx.textDelta(0, 'Hello'))
    mapper.handleMessage(fx.textDelta(0, ' world'))
    const ds = deltas(outputs)
    expect(ds).toEqual([
      { target: 'assistant', eventId, offset: 0, text: 'Hello' },
      { target: 'assistant', eventId, offset: 5, text: ' world' },
    ])

    // 2 s coalesced revision
    vi.advanceTimersByTime(2001)
    const revs = events(outputs)
    expect(revs).toHaveLength(2)
    expect(revs[1]).toMatchObject({ id: eventId, kind: 'assistant', text: 'Hello world', streaming: true })

    mapper.handleMessage(fx.contentBlockStop(0))
    const finals = events(outputs)
    expect(finals[finals.length - 1]).toMatchObject({
      id: eventId,
      kind: 'assistant',
      text: 'Hello world',
      streaming: false,
      final: true,
    })

    // complete assistant message: text matches — no duplicate event emitted
    const before = events(outputs).length
    mapper.handleMessage(fx.assistantMessage({ text: 'Hello world' }))
    expect(events(outputs).length).toBe(before)
    mapper.dispose()
  })

  it('authoritative text from the complete assistant message wins on mismatch', () => {
    const { mapper, outputs } = makeMapper()
    mapper.handleMessage(fx.messageStart())
    mapper.handleMessage(fx.contentBlockStart(0, 'text'))
    mapper.handleMessage(fx.textDelta(0, 'Hel'))
    // block never got its stop — the complete message closes it with full text
    mapper.handleMessage(fx.assistantMessage({ text: 'Hello world' }))
    const evs = events(outputs)
    const final = evs[evs.length - 1]
    expect(final).toMatchObject({ kind: 'assistant', text: 'Hello world', streaming: false, final: true })
    mapper.dispose()
  })
})

describe('message-map: thinking blocks', () => {
  it('streams thinking_delta into a thinking event with durationMs on the final revision', () => {
    const { mapper, outputs } = makeMapper()
    mapper.handleMessage(fx.messageStart())
    mapper.handleMessage(fx.contentBlockStart(0, 'thinking'))
    mapper.handleMessage(fx.thinkingDelta(0, 'pondering...'))
    mapper.handleMessage(fx.contentBlockStop(0))
    const evs = events(outputs)
    expect(evs[0]).toMatchObject({ kind: 'thinking', text: '', streaming: true })
    const final = evs[evs.length - 1]!
    expect(final).toMatchObject({ kind: 'thinking', text: 'pondering...', streaming: false, final: true })
    expect(final).toHaveProperty('durationMs')
    expect(deltas(outputs)).toEqual([
      { target: 'thinking', eventId: evs[0]!.id, offset: 0, text: 'pondering...' },
    ])
    mapper.dispose()
  })

  it('falls back to a whole thinking event when no deltas arrived', () => {
    const { mapper, outputs } = makeMapper()
    mapper.handleMessage(fx.assistantMessage({ thinking: 'deep thought', text: 'answer' }))
    const evs = events(outputs)
    expect(evs[0]).toMatchObject({ kind: 'thinking', text: 'deep thought' })
    expect(evs[1]).toMatchObject({ kind: 'assistant', text: 'answer' })
    mapper.dispose()
  })
})

describe('message-map: 16 KiB rollover', () => {
  it('finalizes the event with final: true and continues in a fresh event id', () => {
    const { mapper, outputs } = makeMapper()
    mapper.handleMessage(fx.messageStart())
    mapper.handleMessage(fx.contentBlockStart(0, 'text'))
    const firstId = events(outputs)[0]!.id

    const chunk = 'x'.repeat(6000)
    mapper.handleMessage(fx.textDelta(0, chunk))
    mapper.handleMessage(fx.textDelta(0, chunk))
    mapper.handleMessage(fx.textDelta(0, chunk)) // crosses 16 384

    const evs = events(outputs)
    const finalized = evs.find((e) => e.id === firstId && e.final === true)
    expect(finalized).toBeDefined()
    expect(finalized).toMatchObject({ kind: 'assistant', streaming: false })
    expect((finalized as { text: string }).text.length).toBe(18000)

    // continuation opened under a fresh id
    const contOpen = evs[evs.length - 1]!
    expect(contOpen.id).not.toBe(firstId)
    expect(contOpen).toMatchObject({ kind: 'assistant', text: '', streaming: true })

    // subsequent deltas target the new id at offset 0
    mapper.handleMessage(fx.textDelta(0, 'after'))
    const ds = deltas(outputs)
    expect(ds[ds.length - 1]).toEqual({
      target: 'assistant',
      eventId: contOpen.id,
      offset: 0,
      text: 'after',
    })

    mapper.handleMessage(fx.contentBlockStop(0))
    const last = events(outputs)[events(outputs).length - 1]
    expect(last).toMatchObject({ id: contOpen.id, text: 'after', streaming: false, final: true })
    mapper.dispose()
  })
})

describe('message-map: tool events (§5.1)', () => {
  it('emits a single running tool event, then success revision via PostToolUse', () => {
    const { mapper, outputs } = makeMapper()
    mapper.handleMessage(
      fx.assistantMessage({
        toolUses: [{ id: 'toolu_01', name: 'Bash', input: { command: 'ls -la' } }],
      }),
    )
    const evs = events(outputs)
    expect(evs[0]).toMatchObject({
      kind: 'tool',
      call: { id: 'toolu_01', name: 'Bash', summary: '$ ls -la', status: 'running' },
    })
    expect(statuses(outputs)).toContain('working')

    mapper.handlePostToolUse(fx.postToolUseInput('Bash', 'toolu_01', 'file1\nfile2', 321))
    const rev = events(outputs)[1]!
    expect(rev.id).toBe(evs[0]!.id) // revision reuses the id
    expect(rev).toMatchObject({
      kind: 'tool',
      final: true,
      call: { id: 'toolu_01', status: 'success', durationMs: 321, output: 'file1\nfile2' },
    })
    const toolFinished = outputs.filter((o) => o.type === 'tool-finished')
    expect(toolFinished).toEqual([{ type: 'tool-finished', toolName: 'Bash', mutating: true }])
    mapper.dispose()
  })

  it('N > 1 tool_use blocks in one assistant message → one tool-group event, calls revised in place', () => {
    const { mapper, outputs } = makeMapper()
    mapper.handleMessage(
      fx.assistantMessage({
        toolUses: [
          { id: 'toolu_a', name: 'Read', input: { file_path: '/home/dev/proj/a.ts' } },
          { id: 'toolu_b', name: 'Grep', input: { pattern: 'foo', path: '/home/dev/proj/src' } },
        ],
      }),
    )
    const evs = events(outputs)
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({
      kind: 'tool-group',
      calls: [
        { id: 'toolu_a', name: 'Read', summary: 'a.ts', status: 'running' },
        { id: 'toolu_b', name: 'Grep', summary: '"foo" in src', status: 'running' },
      ],
    })
    const groupId = evs[0]!.id

    mapper.handlePostToolUse(fx.postToolUseInput('Read', 'toolu_a', 'line1\nline2\nline3', 20))
    let last = events(outputs)[events(outputs).length - 1]!
    expect(last.id).toBe(groupId)
    expect(last).toMatchObject({
      kind: 'tool-group',
      calls: [
        { id: 'toolu_a', status: 'success', output: '3 lines read' },
        { id: 'toolu_b', status: 'running' },
      ],
    })
    expect(last.final).toBeUndefined()

    mapper.handlePostToolUseFailure(fx.postToolUseFailureInput('Grep', 'toolu_b', 'boom', 15))
    last = events(outputs)[events(outputs).length - 1]!
    expect(last).toMatchObject({
      kind: 'tool-group',
      final: true,
      calls: [
        { id: 'toolu_a', status: 'success' },
        { id: 'toolu_b', status: 'error', errorText: 'boom', durationMs: 15 },
      ],
    })
    mapper.dispose()
  })

  it('falls back to user tool_result carriers when hooks missed', () => {
    const { mapper, outputs } = makeMapper()
    mapper.handleMessage(
      fx.assistantMessage({
        toolUses: [{ id: 'toolu_fb', name: 'Bash', input: { command: 'pwd' } }],
      }),
    )
    mapper.handleMessage(fx.userToolResult('toolu_fb', [{ type: 'text', text: '/home/dev/proj' }]))
    const last = events(outputs)[events(outputs).length - 1]!
    expect(last).toMatchObject({
      kind: 'tool',
      call: { id: 'toolu_fb', status: 'success', output: '/home/dev/proj' },
    })
    mapper.dispose()
  })
})

describe('message-map: subagent turn (§5.7)', () => {
  it('creates an AgentRun for Agent/Task tool_use blocks and revises via progress + children + PostToolUse', () => {
    const { mapper, outputs } = makeMapper()
    mapper.handleMessage(
      fx.assistantMessage({
        id: 'msg_parent',
        toolUses: [
          {
            id: 'toolu_agent',
            name: 'Task',
            input: { subagent_type: 'explorer', prompt: 'Map the codebase\nDetails...', model: 'claude-haiku-4' },
          },
        ],
      }),
    )
    const evs = events(outputs)
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({
      kind: 'agent',
      run: {
        id: 'toolu_agent',
        agentType: 'explorer',
        task: 'Map the codebase',
        status: 'running',
        model: 'claude-haiku-4',
        toolUses: 0,
        tokens: 0,
      },
    })
    const agentEventId = evs[0]!.id

    // task_progress (primary progress source)
    mapper.handleMessage(fx.taskStarted('task_1', 'toolu_agent', 'Map the codebase'))
    mapper.handleMessage(
      fx.taskProgress('task_1', 'toolu_agent', { totalTokens: 500, toolUses: 3, durationMs: 1500 }),
    )
    let last = events(outputs)[events(outputs).length - 1]!
    expect(last.id).toBe(agentEventId)
    expect(last).toMatchObject({ kind: 'agent', run: { toolUses: 3, tokens: 500 } })

    // child message enrichment (parent_tool_use_id set) — takes max, no double count
    mapper.handleMessage(
      fx.assistantMessage({
        id: 'msg_child1',
        parentToolUseId: 'toolu_agent',
        toolUses: [
          { id: 'toolu_c1', name: 'Read', input: { file_path: 'x' } },
          { id: 'toolu_c2', name: 'Grep', input: { pattern: 'y' } },
        ],
        usage: fx.usage({ output_tokens: 700 }),
      }),
    )
    last = events(outputs)[events(outputs).length - 1]!
    expect(last).toMatchObject({ kind: 'agent', run: { toolUses: 3, tokens: 700 } })

    // no transcript tool events for child tool_use blocks
    expect(events(outputs).filter((e) => e.kind === 'tool' || e.kind === 'tool-group')).toHaveLength(0)

    // PostToolUse for the Agent call → final revision
    mapper.handlePostToolUse(
      fx.postToolUseInput('Task', 'toolu_agent', 'Explored 42 files. agentId: agent_9', 9000),
    )
    last = events(outputs)[events(outputs).length - 1]!
    expect(last).toMatchObject({
      kind: 'agent',
      final: true,
      run: {
        status: 'success',
        result: 'Explored 42 files. agentId: agent_9',
        durationMs: 9000,
      },
    })
    mapper.dispose()
  })

  it('never produces workflow events', () => {
    const { mapper, outputs } = makeMapper()
    mapper.handleMessage(
      fx.assistantMessage({
        toolUses: [{ id: 'toolu_wf', name: 'Workflow', input: { name: 'spec' } }],
      }),
    )
    const evs = events(outputs)
    // Workflow renders as a plain tool event (05 §5.7 Decision)
    expect(evs[0]!.kind).toBe('tool')
    expect(evs.some((e) => e.kind === 'workflow')).toBe(false)
    mapper.dispose()
  })
})

describe('message-map: todo flows (§5.6)', () => {
  it('TodoWrite rewrites the list under the stable per-session event id', () => {
    const { mapper, outputs } = makeMapper()
    mapper.handleMessage(
      fx.assistantMessage({
        toolUses: [
          {
            id: 'toolu_todo',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'step one', status: 'completed', activeForm: 'doing one' },
                { content: 'step two', status: 'in_progress', activeForm: 'doing two' },
              ],
            },
          },
        ],
      }),
    )
    const evs = events(outputs)
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({
      id: 'ev_todos_ags_test1',
      kind: 'todo',
      todos: [
        { id: 'todo_0', text: 'step one', status: 'completed' },
        { id: 'todo_1', text: 'step two', status: 'in_progress' },
      ],
    })
    // Task tool calls do not also produce tool events
    expect(evs.some((e) => e.kind === 'tool' || e.kind === 'tool-group')).toBe(false)
    mapper.dispose()
  })

  it('TaskCreate inserts on the tool_result id, TaskUpdate patches, TaskList resyncs', () => {
    const { mapper, outputs } = makeMapper()
    mapper.handleMessage(
      fx.assistantMessage({
        toolUses: [{ id: 'toolu_tc', name: 'TaskCreate', input: { subject: 'Fix the bug' } }],
      }),
    )
    expect(events(outputs)).toHaveLength(0) // id arrives with the result
    mapper.handlePostToolUse(
      fx.postToolUseInput('TaskCreate', 'toolu_tc', { task: { id: '7', subject: 'Fix the bug' } }),
    )
    let evs = events(outputs)
    expect(evs[evs.length - 1]).toMatchObject({
      id: 'ev_todos_ags_test1',
      kind: 'todo',
      todos: [{ id: '7', text: 'Fix the bug', status: 'pending' }],
    })

    mapper.handleMessage(
      fx.assistantMessage({
        toolUses: [{ id: 'toolu_tu', name: 'TaskUpdate', input: { taskId: '7', status: 'in_progress' } }],
      }),
    )
    evs = events(outputs)
    expect(evs[evs.length - 1]).toMatchObject({
      kind: 'todo',
      todos: [{ id: '7', text: 'Fix the bug', status: 'in_progress' }],
    })

    mapper.handleMessage(
      fx.assistantMessage({
        toolUses: [{ id: 'toolu_tl', name: 'TaskList', input: {} }],
      }),
    )
    mapper.handlePostToolUse(
      fx.postToolUseInput('TaskList', 'toolu_tl', {
        tasks: [
          { id: '7', subject: 'Fix the bug', status: 'completed' },
          { id: '8', subject: 'Write tests', status: 'pending' },
        ],
      }),
    )
    evs = events(outputs)
    expect(evs[evs.length - 1]).toMatchObject({
      kind: 'todo',
      todos: [
        { id: '7', text: 'Fix the bug', status: 'completed' },
        { id: '8', text: 'Write tests', status: 'pending' },
      ],
    })
    mapper.dispose()
  })
})

describe('message-map: compact boundary + /clear (§10)', () => {
  it('emits the compaction system event and resets the meter to pre_tokens', () => {
    const { mapper, outputs } = makeMapper()
    mapper.handleMessage(fx.assistantMessage({ id: 'msg_1', text: 'hi', usage: fx.usage() }))
    mapper.handleMessage(fx.compactBoundary(150_000, 'auto'))
    const evs = events(outputs)
    const compaction = evs.find((e) => e.kind === 'system' && (e as { variant: string }).variant === 'compaction')
    expect(compaction).toMatchObject({
      text: 'Context compacted — 150000 tokens summarized (auto)',
    })
    mapper.emitStatsNow()
    const st = stats(outputs)
    expect(st[st.length - 1]!.contextUsedTokens).toBe(150_000)
    mapper.dispose()
  })

  it('onContextCleared resets the meter to 0 and emits the info event', () => {
    const { mapper, outputs } = makeMapper()
    mapper.handleMessage(fx.assistantMessage({ id: 'msg_1', text: 'hi' }))
    mapper.onContextCleared()
    const evs = events(outputs)
    expect(evs[evs.length - 1]).toMatchObject({ kind: 'system', variant: 'info', text: 'Context cleared' })
    const st = stats(outputs)
    expect(st[st.length - 1]!.contextUsedTokens).toBe(0)
    mapper.dispose()
  })
})

describe('message-map: result subtypes (§9)', () => {
  it('success → stats + awaiting-input, remembers the result text', () => {
    const { mapper, outputs } = makeMapper()
    const d = mapper.handleMessage(fx.resultSuccess({ result: 'All done', costUsd: 0.5, numTurns: 4 }))
    expect(d).toMatchObject({ type: 'result', subtype: 'success', isError: false })
    expect(mapper.lastSuccessResultText).toBe('All done')
    expect(statuses(outputs)).toEqual(['awaiting-input'])
    const st = stats(outputs)
    expect(st[st.length - 1]).toMatchObject({ costUsd: 0.5, turns: 4 })
    mapper.dispose()
  })

  it('swallows the zero-turn empty init-nudge result (no status, no stats, no directive)', () => {
    const { mapper, outputs } = makeMapper()
    const d = mapper.handleMessage(
      fx.resultSuccess({
        result: '',
        numTurns: 0,
        costUsd: 0,
        usage: fx.usage({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      }),
    )
    expect(d).toBeNull()
    expect(outputs).toHaveLength(0)
    mapper.dispose()
  })

  it('error_max_turns → info event naming the limit + awaiting-input', () => {
    const { mapper, outputs } = makeMapper({ maxTurns: 80 })
    const d = mapper.handleMessage(fx.resultError('error_max_turns'))
    expect(d).toMatchObject({ type: 'result', subtype: 'error_max_turns' })
    expect(events(outputs)[0]).toMatchObject({
      kind: 'system',
      variant: 'info',
      text: 'Turn limit (80) reached — send a message to continue.',
    })
    expect(statuses(outputs)).toEqual(['awaiting-input'])
    mapper.dispose()
  })

  it('error_max_budget_usd → info event naming the budget', () => {
    const { mapper, outputs } = makeMapper({ maxBudgetUsd: 10 })
    mapper.handleMessage(fx.resultError('error_max_budget_usd'))
    expect(events(outputs)[0]).toMatchObject({
      kind: 'system',
      variant: 'info',
      text: 'Budget limit ($10) reached — send a message to continue.',
    })
    mapper.dispose()
  })

  it('error_during_execution → error event with joined errors[], no status transition', () => {
    const { mapper, outputs } = makeMapper()
    const d = mapper.handleMessage(
      fx.resultError('error_during_execution', { errors: ['tool crashed', 'stream lost'] }),
    )
    expect(d).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      errorText: 'tool crashed\nstream lost',
    })
    expect(events(outputs)[0]).toMatchObject({ kind: 'error', text: 'tool crashed\nstream lost' })
    expect(statuses(outputs)).toEqual([]) // adapter owns the retry/fail transition
    mapper.dispose()
  })

  it('error_max_structured_output_retries → error event', () => {
    const { mapper, outputs } = makeMapper()
    mapper.handleMessage(fx.resultError('error_max_structured_output_retries', { errors: ['schema'] }))
    expect(events(outputs)[0]).toMatchObject({ kind: 'error', text: 'schema' })
    mapper.dispose()
  })

  it('terminal_reason aborted_streaming → interrupt semantics, no error event', () => {
    const { mapper, outputs } = makeMapper()
    mapper.handleMessage(
      fx.assistantMessage({
        toolUses: [{ id: 'toolu_run', name: 'Bash', input: { command: 'sleep 60' } }],
      }),
    )
    mapper.handleMessage(fx.resultSuccess({ terminalReason: 'aborted_streaming' }))
    const evs = events(outputs)
    expect(evs.some((e) => e.kind === 'error')).toBe(false)
    const toolRev = evs[evs.length - 1]!
    expect(toolRev).toMatchObject({
      kind: 'tool',
      call: { status: 'error', errorText: INTERRUPTED_ERROR_TEXT },
    })
    expect(statuses(outputs)[statuses(outputs).length - 1]).toBe('awaiting-input')
    mapper.dispose()
  })

  it('terminal_reason prompt_too_long → error event suggesting /compact', () => {
    const { mapper, outputs } = makeMapper()
    mapper.handleMessage(fx.resultSuccess({ terminalReason: 'prompt_too_long' }))
    expect(events(outputs)[0]).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('/compact'),
    })
    mapper.dispose()
  })
})

describe('message-map: assistant error field (§9)', () => {
  it('authentication_failed → error event + failed status + fatal directive', () => {
    const { mapper, outputs } = makeMapper()
    const d = mapper.handleMessage(fx.assistantMessage({ text: '', error: 'authentication_failed' }))
    expect(d).toMatchObject({ type: 'fatal', errorText: AUTH_REVOKED_TEXT })
    expect(events(outputs)[0]).toMatchObject({ kind: 'error', text: AUTH_REVOKED_TEXT })
    expect(statuses(outputs)).toEqual(['failed'])
    mapper.dispose()
  })

  it('billing_error → same fatal path', () => {
    const { mapper } = makeMapper()
    const d = mapper.handleMessage(fx.assistantMessage({ text: '', error: 'billing_error' }))
    expect(d).toMatchObject({ type: 'fatal' })
    mapper.dispose()
  })

  it('rate_limit → warning system event, no fatal, no retry', () => {
    const { mapper, outputs } = makeMapper()
    const d = mapper.handleMessage(fx.assistantMessage({ text: '', error: 'rate_limit' }))
    expect(d).toBeNull()
    expect(events(outputs)[0]).toMatchObject({ kind: 'system', variant: 'info' })
    mapper.dispose()
  })
})

describe('message-map: stats (§8)', () => {
  it('dedupes usage by message.id across parallel tool call repeats', () => {
    const { mapper, outputs } = makeMapper()
    const u = fx.usage({ input_tokens: 100, output_tokens: 50 })
    mapper.handleMessage(fx.assistantMessage({ id: 'msg_dup', text: 'a', usage: u }))
    mapper.handleMessage(fx.assistantMessage({ id: 'msg_dup', text: 'a', usage: u }))
    mapper.emitStatsNow()
    const st = stats(outputs)
    expect(st[st.length - 1]).toMatchObject({ tokensIn: 100, tokensOut: 50 })
    mapper.dispose()
  })

  it('accumulates across query() restarts; result reconciliation wins within a query', () => {
    const { mapper, outputs } = makeMapper()
    mapper.handleMessage(
      fx.assistantMessage({ id: 'm1', text: 'x', usage: fx.usage({ input_tokens: 10, output_tokens: 5 }) }),
    )
    mapper.handleMessage(
      fx.resultSuccess({ usage: fx.usage({ input_tokens: 40, output_tokens: 20, cache_read_input_tokens: 7 }), costUsd: 0.1, numTurns: 2 }),
    )
    let st = stats(outputs)
    expect(st[st.length - 1]).toMatchObject({
      tokensIn: 40,
      tokensOut: 20,
      cacheReadTokens: 7,
      costUsd: 0.1,
      turns: 2,
    })

    mapper.noteQueryRestart()
    mapper.handleMessage(
      fx.resultSuccess({ usage: fx.usage({ input_tokens: 15, output_tokens: 3, cache_read_input_tokens: 1 }), costUsd: 0.05, numTurns: 1 }),
    )
    st = stats(outputs)
    expect(st[st.length - 1]).toMatchObject({
      tokensIn: 55,
      tokensOut: 23,
      cacheReadTokens: 8,
      costUsd: 0.15000000000000002,
      turns: 3,
    })
    mapper.dispose()
  })
})

describe('message-map: auto-deny + informational + default branch', () => {
  it('system/permission_denied → denied permission event + info text, no dock interaction', () => {
    const { mapper, outputs } = makeMapper()
    mapper.handleMessage(fx.permissionDenied('Bash', 'toolu_den', 'deny rule Bash(rm *)'))
    const evs = events(outputs)
    expect(evs[0]).toMatchObject({
      kind: 'permission',
      tool: 'Bash',
      status: 'denied',
      toolUseId: 'toolu_den',
      final: true,
    })
    expect(evs[1]).toMatchObject({
      kind: 'system',
      variant: 'info',
      text: 'Auto-denied Bash — deny rule Bash(rm *)',
    })
    expect(statuses(outputs)).toEqual([]) // no awaiting-permission
    mapper.dispose()
  })

  it('informational notice/warning surface; info/suggestion dropped', () => {
    const { mapper, outputs } = makeMapper()
    mapper.handleMessage(fx.informational('notice', 'heads up'))
    mapper.handleMessage(fx.informational('warning', 'careful'))
    mapper.handleMessage(fx.informational('info', 'noise'))
    mapper.handleMessage(fx.informational('suggestion', 'noise'))
    const evs = events(outputs)
    expect(evs).toHaveLength(2)
    expect(evs.map((e) => (e as { text: string }).text)).toEqual(['heads up', 'careful'])
    mapper.dispose()
  })

  it('unknown message variants never throw and emit nothing', () => {
    const { mapper, outputs } = makeMapper()
    expect(() => {
      mapper.handleMessage({ type: 'auth_status', isAuthenticating: true, output: [] })
      mapper.handleMessage({ type: 'tool_use_summary', summary: 'x', preceding_tool_use_ids: [] })
      mapper.handleMessage({ type: 'system', subtype: 'status', status: 'compacting' })
      mapper.handleMessage({ type: 'some_future_variant', payload: 1 })
      mapper.handleMessage({ type: 'tool_progress', tool_use_id: 't', tool_name: 'Bash', elapsed_time_seconds: 3 })
    }).not.toThrow()
    expect(outputs).toHaveLength(0)
    mapper.dispose()
  })
})

describe('message-map: verdict resolution re-summarization (§6/§5.1)', () => {
  it('updatedInput re-summarizes the tool event so the transcript shows what ran', () => {
    const { mapper, outputs } = makeMapper()
    mapper.handleMessage(
      fx.assistantMessage({
        toolUses: [{ id: 'toolu_edit', name: 'Bash', input: { command: 'rm -rf /' } }],
      }),
    )
    mapper.applyVerdictResolution('toolu_edit', {
      behavior: 'allow',
      message: null,
      updatedInput: { command: 'rm -rf ./tmp' },
      appliedSuggestions: [],
    })
    const evs = events(outputs)
    const rev = evs[evs.length - 1]!
    expect(rev.id).toBe(evs[0]!.id)
    expect(rev).toMatchObject({ kind: 'tool', call: { summary: '$ rm -rf ./tmp', status: 'running' } })
    mapper.dispose()
  })
})
