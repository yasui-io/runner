/**
 * ClaudeCodeAdapter tests: start/init handshake, buildEnv strip+inject, model
 * validation, resume cwd pinning, send/slash plumbing, §9 restart & stop flows,
 * output() single-consumer contract.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AdapterOutput, HarnessSessionConfig } from '../src/sessions/harness-adapter'
import {
  ClaudeCodeAdapter,
  RUNNER_VERSION,
  buildEnv,
  encodeCwd,
  type QueryFn,
} from '../src/sessions/claude/claude-adapter'
import { PushQueue } from '../src/sessions/claude/input-queue'
import * as fx from './fixtures/claude/messages'

/* ---------------------------------------------------------------- fake query */

class FakeQuery implements AsyncIterable<unknown> {
  readonly messages = new PushQueue<unknown>()
  readonly received: SDKUserMessage[] = []
  interruptCalls = 0
  setModelCalls: string[] = []
  setPermissionModeCalls: string[] = []
  closed = false
  private failNext: unknown = null

  constructor(
    readonly prompt: AsyncIterable<SDKUserMessage>,
    readonly options: Options | undefined,
  ) {
    void this.consumePrompt()
  }

  private async consumePrompt(): Promise<void> {
    try {
      for await (const msg of this.prompt) {
        // drop the shouldQuery:false init nudge (see InputQueue.pushInitNudge)
        if (msg.shouldQuery === false) continue
        this.received.push(msg)
      }
    } catch {
      /* input closed */
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    for await (const msg of this.messages) {
      if (msg && typeof msg === 'object' && '__throw' in (msg as object)) {
        throw (msg as { __throw: unknown }).__throw
      }
      yield msg
    }
    if (this.failNext) throw this.failNext
  }

  push(msg: unknown): void {
    this.messages.push(msg)
  }
  end(): void {
    this.messages.close()
  }
  endWith(err: unknown): void {
    this.failNext = err
    this.messages.close()
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1
  }
  async setModel(model?: string): Promise<void> {
    this.setModelCalls.push(model ?? '')
  }
  async setPermissionMode(mode: string): Promise<void> {
    this.setPermissionModeCalls.push(mode)
  }
  async getContextUsage(): Promise<{ totalTokens: number }> {
    return { totalTokens: 1234 }
  }
  close(): void {
    this.closed = true
    this.messages.close() // real Query.close() force-terminates the subprocess
  }
}

function makeHarness() {
  const queries: FakeQuery[] = []
  const queryFn: QueryFn = ({ prompt, options }) => {
    const q = new FakeQuery(prompt, options)
    queries.push(q)
    return q as never
  }
  return { queries, queryFn }
}

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeConfig(overrides: Partial<HarnessSessionConfig> = {}): HarnessSessionConfig {
  const configDir = mkdtempSync(join(tmpdir(), 'yasui-claude-test-'))
  tempDirs.push(configDir)
  return {
    sessionId: 'ags_adapter1',
    projectPath: '/home/dev/proj',
    projectTrusted: false,
    model: 'claude-sonnet-4-5',
    contextWindowTokens: 200_000,
    permissionMode: 'default',
    permissionTimeoutMinutes: 15,
    systemPromptAppend: null,
    maxTurns: 80,
    maxBudgetUsd: 10,
    resumeHarnessSessionId: null,
    inference: { baseUrl: 'https://api.yasui.io', authToken: 'yk_test_secret' },
    paths: { claudeConfigDir: configDir, sessionLog: join(configDir, 'session.log') },
    ...overrides,
  }
}

function drainOutputs(adapter: ClaudeCodeAdapter): { outputs: AdapterOutput[]; done: Promise<void> } {
  const outputs: AdapterOutput[] = []
  const done = (async () => {
    for await (const out of adapter.output()) outputs.push(out)
  })()
  return { outputs, done }
}

async function tick(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}

/* ------------------------------------------------------------------ buildEnv */

describe('buildEnv', () => {
  it('spreads process.env, strips the exact §3 key list, injects the Yasui env', () => {
    const saved: Record<string, string | undefined> = {}
    const poison: Record<string, string> = {
      ANTHROPIC_API_KEY: 'leak',
      CLAUDE_CODE_OAUTH_TOKEN: 'leak',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
      CLAUDE_CODE_USE_ANTHROPIC_AWS: '1',
      ANTHROPIC_BASE_URL: 'https://evil.example',
      ANTHROPIC_MODEL: 'other',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'x',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'x',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'x',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'x',
      ANTHROPIC_CUSTOM_MODEL_OPTION: 'x',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Evil: 1',
    }
    for (const [k, v] of Object.entries(poison)) {
      saved[k] = process.env[k]
      process.env[k] = v
    }
    try {
      const config = makeConfig()
      const env = buildEnv(config)
      // stripped keys must not carry the poisoned values (BASE_URL is re-injected as ours)
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
      expect(env.CLAUDE_CODE_USE_VERTEX).toBeUndefined()
      expect(env.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined()
      expect(env.CLAUDE_CODE_USE_ANTHROPIC_AWS).toBeUndefined()
      expect(env.ANTHROPIC_MODEL).toBeUndefined()
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined()
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined()
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
      expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBeUndefined()
      expect(env.ANTHROPIC_CUSTOM_MODEL_OPTION).toBeUndefined()
      expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
      // injected
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.yasui.io')
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('yk_test_secret')
      expect(env.CLAUDE_CONFIG_DIR).toBe(config.paths.claudeConfigDir)
      expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
      expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1')
      expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1')
      expect(env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT).toBe('1')
      expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
      expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe(`yasui-runner/${RUNNER_VERSION}`)
      // inherited env survives (PATH is always set)
      expect(env.PATH).toBe(process.env.PATH)
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})

/* --------------------------------------------------------------------- start */

describe('ClaudeCodeAdapter.start', () => {
  it('boots query() with the exact §3 options block and resolves on init', async () => {
    const { queries, queryFn } = makeHarness()
    const adapter = new ClaudeCodeAdapter({ queryFn })
    const config = makeConfig()
    const startPromise = adapter.start(config)
    await tick()
    expect(queries).toHaveLength(1)
    const q = queries[0]!
    const o = q.options!
    expect(o.cwd).toBe('/home/dev/proj')
    expect(o.model).toBe('claude-sonnet-4-5')
    expect(o.permissionMode).toBe('default')
    expect(o.allowDangerouslySkipPermissions).toBe(false)
    expect(o.allowedTools).toEqual([])
    expect(o.disallowedTools).toEqual(['AskUserQuestion'])
    expect(o.includePartialMessages).toBe(true)
    expect(o.agentProgressSummaries).toBe(true)
    expect(o.maxTurns).toBe(80)
    expect(o.maxBudgetUsd).toBe(10)
    expect(o.resume).toBeUndefined()
    expect(o.persistSession).toBe(true)
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: undefined })
    expect(o.settingSources).toEqual([]) // untrusted project
    expect(typeof o.canUseTool).toBe('function')
    expect(o.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1)
    expect(o.hooks?.PostToolUse?.[0]?.hooks).toHaveLength(1)
    expect(o.hooks?.PostToolUseFailure?.[0]?.hooks).toHaveLength(1)
    expect(o.env?.ANTHROPIC_AUTH_TOKEN).toBe('yk_test_secret')
    // Decisions: keys that must NOT be set
    expect(o.fallbackModel).toBeUndefined()
    expect(o.enableFileCheckpointing).toBeUndefined()
    expect(o.mcpServers).toBeUndefined()
    expect(o.forwardSubagentText).toBeUndefined()

    q.push(fx.initMessage())
    const started = await startPromise
    expect(started).toEqual({
      harnessSessionId: fx.SESSION_ID,
      model: 'claude-sonnet-4-5',
      permissionMode: 'default',
      slashCommands: ['clear', 'compact', 'context', 'usage'],
      tools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Task'],
      contextWindowTokens: 200_000, // echoed from the catalog, NOT the SDK
    })
    await adapter.stop('shutdown')
  })

  it('trusted projects load project+local settings; bypassPermissions gates the skip flag', async () => {
    const { queries, queryFn } = makeHarness()
    const adapter = new ClaudeCodeAdapter({ queryFn })
    const startPromise = adapter.start(
      makeConfig({ projectTrusted: true, permissionMode: 'bypassPermissions' }),
    )
    await tick()
    const o = queries[0]!.options!
    expect(o.settingSources).toEqual(['project', 'local'])
    expect(o.permissionMode).toBe('bypassPermissions')
    expect(o.allowDangerouslySkipPermissions).toBe(true)
    queries[0]!.push(fx.initMessage({ permissionMode: 'bypassPermissions' }))
    await startPromise
    await adapter.stop('shutdown')
  })

  it('rejects non-Claude slugs with yasui_runner_unsupported_model', async () => {
    const adapter = new ClaudeCodeAdapter({ queryFn: makeHarness().queryFn })
    await expect(adapter.start(makeConfig({ model: 'gpt-5o' }))).rejects.toMatchObject({
      code: 'yasui_runner_unsupported_model',
    })
  })

  it('fails fast with yasui_runner_resume_cwd_mismatch when the transcript lives under another cwd', async () => {
    const config = makeConfig({ resumeHarnessSessionId: 'sess-123' })
    // recorded under a DIFFERENT encoded cwd
    const otherDir = join(config.paths.claudeConfigDir, 'projects', encodeCwd('/somewhere/else'))
    mkdirSync(otherDir, { recursive: true })
    writeFileSync(join(otherDir, 'sess-123.jsonl'), '{}\n')
    const adapter = new ClaudeCodeAdapter({ queryFn: makeHarness().queryFn })
    await expect(adapter.start(config)).rejects.toMatchObject({
      code: 'yasui_runner_resume_cwd_mismatch',
    })
  })

  it('passes resume through when the transcript matches the pinned cwd', async () => {
    const config = makeConfig({ resumeHarnessSessionId: 'sess-456' })
    const dir = join(config.paths.claudeConfigDir, 'projects', encodeCwd(config.projectPath))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'sess-456.jsonl'), '{}\n')
    const { queries, queryFn } = makeHarness()
    const adapter = new ClaudeCodeAdapter({ queryFn })
    const startPromise = adapter.start(config)
    await tick()
    expect(queries[0]!.options!.resume).toBe('sess-456')
    queries[0]!.push(fx.initMessage({ session_id: 'sess-456' }))
    await startPromise
    await adapter.stop('shutdown')
  })

  it('rejects start() when the process dies before init', async () => {
    const { queries, queryFn } = makeHarness()
    const adapter = new ClaudeCodeAdapter({ queryFn })
    const startPromise = adapter.start(makeConfig())
    await tick()
    queries[0]!.endWith(new Error('spawn failed'))
    await expect(startPromise).rejects.toMatchObject({ code: 'yasui_runner_harness_unavailable' })
  })
})

/* ---------------------------------------------------------------- send/slash */

describe('ClaudeCodeAdapter.send', () => {
  it('pushes plain text and "/cmd args" into the input queue; /clear resets the meter', async () => {
    const { queries, queryFn } = makeHarness()
    const adapter = new ClaudeCodeAdapter({ queryFn })
    const startPromise = adapter.start(makeConfig())
    await tick()
    queries[0]!.push(fx.initMessage())
    await startPromise
    const { outputs } = drainOutputs(adapter)

    await adapter.send({ kind: 'message', eventId: 'ev_u1', text: 'fix the tests' })
    await adapter.send({ kind: 'slash', eventId: 'ev_s1', command: 'compact', args: null })
    await adapter.send({ kind: 'slash', eventId: 'ev_s2', command: 'fix-issue', args: '123 high' })
    await adapter.send({ kind: 'slash', eventId: 'ev_s3', command: 'clear', args: null })
    await tick()

    expect(queries[0]!.received.map((m) => m.message.content)).toEqual([
      'fix the tests',
      '/compact',
      '/fix-issue 123 high',
      '/clear',
    ])
    // §7: /clear emits the info event + meter reset; nothing else emitted for
    // sends (the buffered connect event from init is the only other output)
    const events = outputs.filter((o) => o.type === 'event')
    expect(events).toHaveLength(2)
    expect(events[0]!.event).toMatchObject({ kind: 'system', variant: 'connect' })
    expect(events[1]!.event).toMatchObject({ kind: 'system', variant: 'info', text: 'Context cleared' })
    await adapter.stop('shutdown')
  })
})

/* ------------------------------------------------------------ control methods */

describe('ClaudeCodeAdapter control methods', () => {
  async function started() {
    const { queries, queryFn } = makeHarness()
    const adapter = new ClaudeCodeAdapter({ queryFn })
    const startPromise = adapter.start(makeConfig())
    await tick()
    queries[0]!.push(fx.initMessage())
    await startPromise
    return { adapter, queries }
  }

  it('setModel forwards to q.setModel and emits a model-change system event', async () => {
    const { adapter, queries } = await started()
    const { outputs } = drainOutputs(adapter)
    await adapter.setModel('claude-opus-4-8')
    await tick()
    expect(queries[0]!.setModelCalls).toEqual(['claude-opus-4-8'])
    const events = outputs.filter((o) => o.type === 'event')
    // events[0] is the buffered connect event from init
    expect(events[1]!.event).toMatchObject({ kind: 'system', variant: 'model-change' })
    await expect(adapter.setModel('gemini-pro')).rejects.toMatchObject({
      code: 'yasui_runner_unsupported_model',
    })
    await adapter.stop('shutdown')
  })

  it('setPermissionMode forwards and emits an info event', async () => {
    const { adapter, queries } = await started()
    const { outputs } = drainOutputs(adapter)
    await adapter.setPermissionMode('acceptEdits')
    await tick()
    expect(queries[0]!.setPermissionModeCalls).toEqual(['acceptEdits'])
    // [0] is the buffered connect event from init
    expect(outputs.filter((o) => o.type === 'event')[1]!.event).toMatchObject({
      kind: 'system',
      variant: 'info',
      text: 'Permission mode set to acceptEdits',
    })
    await adapter.stop('shutdown')
  })

  it('interrupt is an idempotent no-op when idle', async () => {
    const { adapter, queries } = await started()
    await adapter.interrupt()
    await adapter.interrupt()
    expect(queries[0]!.interruptCalls).toBe(0) // status idle — never active
    await adapter.stop('shutdown')
  })

  it('interrupt mid-turn calls q.interrupt and lands on awaiting-input', async () => {
    const { adapter, queries } = await started()
    const { outputs } = drainOutputs(adapter)
    queries[0]!.push(fx.messageStart())
    await tick()
    await adapter.interrupt()
    expect(queries[0]!.interruptCalls).toBe(1)
    const statusList = outputs.filter((o) => o.type === 'status').map((o) => o.status)
    expect(statusList).toEqual(['idle', 'streaming', 'awaiting-input']) // idle buffered from init
    await adapter.stop('shutdown')
  })
})

/* ------------------------------------------------------------- restart / end */

describe('ClaudeCodeAdapter §9 lifecycle', () => {
  it('transparently restarts once on generator crash, resuming and re-delivering unanswered input', async () => {
    const { queries, queryFn } = makeHarness()
    const adapter = new ClaudeCodeAdapter({ queryFn })
    const startPromise = adapter.start(makeConfig())
    await tick()
    queries[0]!.push(fx.initMessage())
    await startPromise
    const { outputs } = drainOutputs(adapter)

    await adapter.send({ kind: 'message', eventId: 'ev_u1', text: 'do the thing' })
    await tick()
    queries[0]!.endWith(new Error('subprocess died'))
    await tick(6)

    expect(queries).toHaveLength(2)
    expect(queries[1]!.options!.resume).toBe(fx.SESSION_ID)
    // unanswered input re-delivered into the fresh InputQueue
    expect(queries[1]!.received.map((m) => m.message.content)).toEqual(['do the thing'])

    // resumed init is swallowed — only the FIRST connect event exists
    queries[1]!.push(fx.initMessage())
    await tick()
    const connects = outputs.filter(
      (o) => o.type === 'event' && o.event.kind === 'system' && (o.event as { variant: string }).variant === 'connect',
    )
    expect(connects).toHaveLength(1)
    await adapter.stop('shutdown')
  })

  it('second crash → failed status + ended(failed); output() ends', async () => {
    const { queries, queryFn } = makeHarness()
    const adapter = new ClaudeCodeAdapter({ queryFn })
    const startPromise = adapter.start(makeConfig())
    await tick()
    queries[0]!.push(fx.initMessage())
    await startPromise
    const { outputs, done } = drainOutputs(adapter)

    queries[0]!.endWith(new Error('crash 1'))
    await tick(6)
    queries[1]!.endWith(new Error('crash 2'))
    await tick(6)
    await done

    const statusList = outputs.filter((o) => o.type === 'status').map((o) => o.status)
    expect(statusList[statusList.length - 1]).toBe('failed')
    const last = outputs[outputs.length - 1]!
    expect(last).toMatchObject({ type: 'ended', reason: 'failed' })
    expect((last as { errorText: string }).errorText).toContain('crash 2')
  })

  it('error_during_execution: one restart with resume, second failure gives up', async () => {
    const { queries, queryFn } = makeHarness()
    const adapter = new ClaudeCodeAdapter({ queryFn })
    const startPromise = adapter.start(makeConfig())
    await tick()
    queries[0]!.push(fx.initMessage())
    await startPromise
    const { outputs, done } = drainOutputs(adapter)

    queries[0]!.push(fx.resultError('error_during_execution', { errors: ['first blowup'] }))
    queries[0]!.endWith(new Error('query throws after error result'))
    await tick(6)
    expect(queries).toHaveLength(2) // retried ONCE with resume
    expect(queries[1]!.options!.resume).toBe(fx.SESSION_ID)

    queries[1]!.push(fx.initMessage())
    queries[1]!.push(fx.resultError('error_during_execution', { errors: ['second blowup'] }))
    queries[1]!.endWith(new Error('query throws again'))
    await tick(6)
    await done

    expect(queries).toHaveLength(2) // no third attempt
    const last = outputs[outputs.length - 1]!
    expect(last).toMatchObject({ type: 'ended', reason: 'failed', errorText: 'second blowup' })
  })

  it('error_max_turns: generator end does NOT restart until the next input', async () => {
    const { queries, queryFn } = makeHarness()
    const adapter = new ClaudeCodeAdapter({ queryFn })
    const startPromise = adapter.start(makeConfig())
    await tick()
    queries[0]!.push(fx.initMessage())
    await startPromise
    const { outputs } = drainOutputs(adapter)

    queries[0]!.push(fx.resultError('error_max_turns'))
    queries[0]!.endWith(new Error('throws after error result'))
    await tick(6)
    expect(queries).toHaveLength(1) // lazy restart

    await adapter.send({ kind: 'message', eventId: 'ev_u1', text: 'continue' })
    await tick(6)
    expect(queries).toHaveLength(2)
    expect(queries[1]!.options!.resume).toBe(fx.SESSION_ID)
    expect(queries[1]!.received.map((m) => m.message.content)).toEqual(['continue'])

    const infoEvents = outputs.filter(
      (o) =>
        o.type === 'event' &&
        o.event.kind === 'system' &&
        (o.event as { variant: string }).variant === 'info',
    )
    expect(infoEvents[0]!.event).toMatchObject({ text: 'Turn limit (80) reached — send a message to continue.' })
    await adapter.stop('shutdown')
  })

  it('assistant auth error → error event, failed, ended(failed) without retry', async () => {
    const { queries, queryFn } = makeHarness()
    const adapter = new ClaudeCodeAdapter({ queryFn })
    const startPromise = adapter.start(makeConfig())
    await tick()
    queries[0]!.push(fx.initMessage())
    await startPromise
    const { outputs, done } = drainOutputs(adapter)

    queries[0]!.push(fx.assistantMessage({ text: '', error: 'authentication_failed' }))
    await tick(6)
    await done

    expect(queries).toHaveLength(1) // NOT retried
    const last = outputs[outputs.length - 1]!
    expect(last).toMatchObject({ type: 'ended', reason: 'failed' })
    const errorEvents = outputs.filter((o) => o.type === 'event' && o.event.kind === 'error')
    expect(errorEvents).toHaveLength(1)
  })

  it('stop(): grace flow ends with ended(reason ended) carrying the last success summary', async () => {
    const { queries, queryFn } = makeHarness()
    const adapter = new ClaudeCodeAdapter({ queryFn, graceMs: 50 })
    const startPromise = adapter.start(makeConfig())
    await tick()
    queries[0]!.push(fx.initMessage())
    await startPromise
    const { outputs, done } = drainOutputs(adapter)

    queries[0]!.push(fx.resultSuccess({ result: 'A'.repeat(300) }))
    await tick()
    await adapter.stop('user')
    await done

    const last = outputs[outputs.length - 1]!
    expect(last).toMatchObject({ type: 'ended', reason: 'ended', errorText: null })
    expect((last as { resultSummary: string }).resultSummary).toHaveLength(200)
    // output() iterable is closed after 'ended'
    expect(outputs.filter((o) => o.type === 'ended')).toHaveLength(1)
  })

  it('output() rejects a second consumer', async () => {
    const { queries, queryFn } = makeHarness()
    const adapter = new ClaudeCodeAdapter({ queryFn })
    const startPromise = adapter.start(makeConfig())
    await tick()
    queries[0]!.push(fx.initMessage())
    await startPromise
    adapter.output()[Symbol.asyncIterator]()
    expect(() => adapter.output()[Symbol.asyncIterator]()).toThrow('single consumer')
    await adapter.stop('shutdown')
  })

  it('send after ended throws yasui_runner_internal', async () => {
    const { queries, queryFn } = makeHarness()
    const adapter = new ClaudeCodeAdapter({ queryFn, graceMs: 10 })
    const startPromise = adapter.start(makeConfig())
    await tick()
    queries[0]!.push(fx.initMessage())
    await startPromise
    await adapter.stop('user')
    await expect(adapter.send({ kind: 'message', eventId: 'e', text: 'x' })).rejects.toMatchObject({
      code: 'yasui_runner_internal',
    })
  })
})
