/**
 * ClaudeCodeAdapter — the `claude-code` HarnessAdapter over
 * `@anthropic-ai/claude-agent-sdk` `query()` in streaming input mode (05).
 *
 * One in-process query() per active session; the runLoop consumes the Query async
 * generator and translates every SDKMessage via MessageMapper (§5). The generator
 * ending or throwing while the session is still open triggers transparent restart
 * with `resume: harnessSessionId` (§2/§9).
 *
 * Options-block verification against the installed SDK (0.3.202) — every key in the
 * 05 §3 block exists in `Options` with 05's exact spelling: cwd, model, permissionMode,
 * allowDangerouslySkipPermissions, allowedTools, disallowedTools,
 * includePartialMessages, agentProgressSummaries, maxTurns, maxBudgetUsd,
 * abortController, resume, systemPrompt (preset+append), settingSources (union is
 * exactly 'user' | 'project' | 'local'), canUseTool, hooks, env, stderr. Nothing had
 * to be re-mapped. `persistSession: true` is the SDK default and set explicitly (§2).
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  query as sdkQuery,
  type HookCallback,
  type Options,
  type PostToolUseFailureHookInput,
  type PostToolUseHookInput,
  type PreToolUseHookInput,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { PermissionMode } from '@yasui.io/runner-protocol'
import { PERMISSION_MODES } from '@yasui.io/runner-protocol'
import type {
  AdapterOutput,
  HarnessAdapter,
  HarnessSessionConfig,
  HarnessStarted,
  PermissionVerdict,
} from '../harness-adapter'
import { RUNNER_VERSION } from '../../version'
import { InputQueue, PushQueue } from './input-queue'
import { MessageMapper, type MapperDirective } from './message-map'
import { PermissionBridge } from './permission-bridge'
import { AdapterError, type AdapterLogger, newEventId, noopLogger, nowIso } from './support'

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>
  options?: Options
}) => Query

export { RUNNER_VERSION }

const RESULT_SUMMARY_MAX = 200
const DEFAULT_GRACE_MS = 5_000
const HARD_KILL_BACKSTOP_MS = 10_000

const ACTIVE_STATUSES = new Set(['streaming', 'working', 'awaiting-permission'])

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    ;(t as { unref?: () => void }).unref?.()
  })
}

/** `<encoded-cwd>` — absolute cwd with every non-alphanumeric char replaced by `-` (sdk-sessions §2). */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * `Options.env` REPLACES the subprocess environment (verified: the installed Options
 * doc says exactly that), so spread process.env, strip anything that could redirect
 * auth or model selection, then inject ours (05 §3 — exact list).
 */
export function buildEnv(config: HarnessSessionConfig): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  // Strip auth that could shadow ANTHROPIC_AUTH_TOKEN (only the provider flags truly
  // outrank it) plus anything that redirects model selection or injects headers
  // (sdk-hosting §2–§3):
  for (const k of [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_CUSTOM_MODEL_OPTION',
    'ANTHROPIC_CUSTOM_HEADERS',
  ]) {
    delete env[k]
  }
  return {
    ...env,
    ANTHROPIC_BASE_URL: config.inference.baseUrl, // Yasui gateway (Anthropic Messages protocol)
    ANTHROPIC_AUTH_TOKEN: config.inference.authToken, // session-scoped yk_ key; RAM only, never disk
    CLAUDE_CONFIG_DIR: config.paths.claudeConfigDir, // runner-scoped dir (04 §9); §2 resume
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', // telemetry+error-reporting+autoupdater+feedback
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', // loads regardless of settingSources otherwise
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1', // gateway may relay to non-Anthropic nodes
    CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1', // Yasui slugs may be unrecognized model ids
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0', // stable prompts → gateway cache hits
    CLAUDE_AGENT_SDK_CLIENT_APP: `yasui-runner/${RUNNER_VERSION}`,
  }
}

export interface ClaudeCodeAdapterOptions {
  logger?: AdapterLogger
  /** injectable for tests — defaults to the real SDK query() */
  queryFn?: QueryFn
  graceMs?: number
  newId?: () => string
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly harness = 'claude-code' as const

  private readonly log: AdapterLogger
  private readonly queryFn: QueryFn
  private readonly graceMs: number
  private readonly newId: () => string

  private readonly out = new PushQueue<AdapterOutput>()
  private config!: HarnessSessionConfig
  private mapper!: MessageMapper
  private bridge!: PermissionBridge
  private inputQueue!: InputQueue
  private abort!: AbortController
  private q: Query | null = null
  private runLoopPromise: Promise<void> | null = null

  private started = false
  private stopping = false
  private endedEmitted = false
  private harnessSessionId: string | null = null
  private lastStatus: string | null = null

  private startWaiter: {
    resolve(started: HarnessStarted): void
    reject(err: unknown): void
  } | null = null
  private resultWaiters: Array<() => void> = []

  /** user message texts pushed but not yet answered by a result — re-delivered on restart (§2) */
  private unansweredInputs: string[] = []
  private needsRestartOnNextInput = false
  private executionRetryUsed = false
  private crashRestartUsed = false
  private lastResultSubtype: string | null = null
  private lastResultErrorText: string | null = null

  constructor(opts: ClaudeCodeAdapterOptions = {}) {
    this.log = opts.logger ?? noopLogger
    this.queryFn = opts.queryFn ?? (sdkQuery as QueryFn)
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS
    this.newId = opts.newId ?? newEventId
  }

  /* ------------------------------------------------------------------ start */

  async start(config: HarnessSessionConfig): Promise<HarnessStarted> {
    if (this.started) throw new AdapterError('yasui_runner_internal', 'adapter already started')
    // §4: the Yasui catalog slug IS the model id — identity mapping; a non-Claude
    // slug means the web misrouted.
    if (!config.model.startsWith('claude-')) {
      throw new AdapterError(
        'yasui_runner_unsupported_model',
        `claude-code cannot run model "${config.model}"`,
      )
    }
    this.assertResumeCwd(config)

    this.config = config
    this.started = true
    this.mapper = new MessageMapper({
      sessionId: config.sessionId,
      cwd: config.projectPath,
      maxTurns: config.maxTurns,
      maxBudgetUsd: config.maxBudgetUsd,
      emit: (out) => this.emitOutput(out),
      log: this.log,
      newId: this.newId,
    })
    this.bridge = new PermissionBridge({
      sessionId: config.sessionId,
      cwd: config.projectPath,
      permissionTimeoutMinutes: config.permissionTimeoutMinutes,
      emit: (out) => this.emitOutput(out),
      log: this.log,
      newId: this.newId,
      onResolved: (toolUseId, verdict) => this.mapper.applyVerdictResolution(toolUseId, verdict),
    })

    const startPromise = new Promise<HarnessStarted>((resolve, reject) => {
      this.startWaiter = { resolve, reject }
    })
    this.startQuery(config.resumeHarnessSessionId)
    return startPromise
  }

  /**
   * §2 resume cwd pinning: transcripts live under
   * `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-id>.jsonl` and resume only
   * works when cwd is byte-identical. Practical check: fail fast when the recorded
   * transcript exists under a DIFFERENT encoded cwd; a transcript missing everywhere
   * (e.g. swept by cleanupPeriodDays) is logged and left to the SDK.
   */
  private assertResumeCwd(config: HarnessSessionConfig): void {
    const resumeId = config.resumeHarnessSessionId
    if (!resumeId) return
    const projectsDir = join(config.paths.claudeConfigDir, 'projects')
    const encoded = encodeCwd(config.projectPath)
    const fileName = `${resumeId}.jsonl`
    if (existsSync(join(projectsDir, encoded, fileName))) return
    if (existsSync(projectsDir)) {
      for (const dir of readdirSync(projectsDir)) {
        if (dir === encoded) continue
        if (existsSync(join(projectsDir, dir, fileName))) {
          throw new AdapterError(
            'yasui_runner_resume_cwd_mismatch',
            `session ${resumeId} was recorded under cwd "${dir}", not "${encoded}" — resume requires the original project path`,
          )
        }
      }
    }
    this.log.warn(
      { sessionId: config.sessionId, resumeId },
      'resume transcript not found under CLAUDE_CONFIG_DIR — the SDK will start fresh',
    )
  }

  private buildOptions(config: HarnessSessionConfig, resumeId: string | null): Options {
    return {
      cwd: config.projectPath, // resolved cwd — worktree path when in a worktree (04 §9)
      model: config.model, // §4 identity mapping
      permissionMode: config.permissionMode, // §6: our 4 modes are a strict subset of the SDK union
      allowDangerouslySkipPermissions: config.permissionMode === 'bypassPermissions',
      allowedTools: [], // nothing auto-approved by us; modes/rules decide
      disallowedTools: ['AskUserQuestion'], // §6 — bare name strips the tool from context
      includePartialMessages: true, // §5 deltas
      agentProgressSummaries: true, // §5.7 — subagent progress via task_progress
      maxTurns: config.maxTurns ?? 80, // §9 on error_max_turns
      maxBudgetUsd: config.maxBudgetUsd ?? 10, // safety net; authoritative billing is the gateway
      abortController: this.abort,
      resume: resumeId ?? undefined,
      persistSession: true, // §2 — always; forkSession unused in v1
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: config.systemPromptAppend ?? undefined,
      },
      // Decision §11: [] unless the project is trusted; never 'user'
      settingSources: config.projectTrusted ? ['project', 'local'] : [],
      canUseTool: this.bridge.canUseTool, // §6
      hooks: {
        PreToolUse: [{ hooks: [this.onPreToolUse] }], // no matcher = all tools
        PostToolUse: [{ hooks: [this.onPostToolUse] }],
        PostToolUseFailure: [{ hooks: [this.onPostToolUseFailure] }],
      },
      env: buildEnv(config),
      stderr: (line: string) =>
        this.log.debug({ sessionId: config.sessionId, line }, 'claude stderr'),
      // Decisions (05 §3): no fallbackModel (gateway owns routing/fallback);
      // enableFileCheckpointing off; no programmatic mcpServers and default
      // strictMcpConfig (false) — project .mcp.json loads via settingSources for
      // trusted projects only; forwardSubagentText: false is the SDK default;
      // ENABLE_TOOL_SEARCH stays unset.
    }
  }

  private startQuery(resumeId: string | null): void {
    this.inputQueue = new InputQueue()
    this.abort = new AbortController()
    this.lastResultSubtype = null
    this.lastResultErrorText = null
    const q = this.queryFn({
      prompt: this.inputQueue,
      options: this.buildOptions(this.config, resumeId),
    })
    this.q = q
    this.runLoopPromise = this.runLoop(q)
    // Un-gate the init handshake (see InputQueue.pushInitNudge): without any input
    // the CLI never emits system/init and start() would hang.
    this.inputQueue.pushInitNudge()
  }

  /* ---------------------------------------------------------------- runLoop */

  private async runLoop(q: Query): Promise<void> {
    try {
      for await (const raw of q) {
        const directive = this.mapper.handleMessage(raw)
        if (directive) this.handleDirective(directive)
      }
      this.onGeneratorExit(null)
    } catch (err) {
      this.onGeneratorExit(err)
    }
  }

  private handleDirective(directive: MapperDirective): void {
    switch (directive.type) {
      case 'init': {
        this.harnessSessionId = directive.harnessSessionId || this.harnessSessionId
        if (this.startWaiter) {
          const waiter = this.startWaiter
          this.startWaiter = null
          const mode = (PERMISSION_MODES as readonly string[]).includes(directive.permissionMode)
            ? (directive.permissionMode as PermissionMode)
            : this.config.permissionMode
          waiter.resolve({
            harnessSessionId: directive.harnessSessionId,
            model: directive.model || this.config.model,
            permissionMode: mode,
            slashCommands: directive.slashCommands,
            tools: directive.tools,
            // NOT derived from the SDK — echoed from session.start / the catalog (§4)
            contextWindowTokens: this.config.contextWindowTokens,
          })
        }
        return
      }
      case 'result': {
        this.lastResultSubtype = directive.subtype
        this.lastResultErrorText = directive.errorText
        this.unansweredInputs = []
        if (directive.subtype === 'success') {
          this.executionRetryUsed = false
          this.crashRestartUsed = false
          this.needsRestartOnNextInput = false
        }
        const waiters = this.resultWaiters.splice(0)
        for (const w of waiters) w()
        // §10 verify item resolved: getContextUsage() offers exact occupancy — prefer it.
        void this.refreshContextUsage()
        return
      }
      case 'fatal':
        this.failSession(directive.errorText)
        return
    }
  }

  /** §9 restart / failure matrix once the generator terminates. */
  private onGeneratorExit(err: unknown): void {
    this.q = null
    if (this.stopping || this.endedEmitted) return

    if (this.startWaiter) {
      // died before the init handshake — start() fails, no output consumer yet
      const waiter = this.startWaiter
      this.startWaiter = null
      this.endedEmitted = true
      this.mapper.dispose()
      this.out.close()
      waiter.reject(
        err instanceof AdapterError
          ? err
          : new AdapterError(
              'yasui_runner_harness_unavailable',
              `Claude Code failed to start: ${String(err ?? 'process exited')}`,
            ),
      )
      return
    }

    const subtype = this.lastResultSubtype
    this.lastResultSubtype = null

    if (subtype === 'error_max_turns' || subtype === 'error_max_budget_usd') {
      // single-run throw semantics: restart lazily on the next input (§9)
      this.needsRestartOnNextInput = true
      return
    }
    if (subtype === 'error_during_execution' || subtype === 'error_max_structured_output_retries') {
      if (!this.executionRetryUsed) {
        this.executionRetryUsed = true
        this.restart('execution-error retry')
        return
      }
      this.failSession(this.lastResultErrorText ?? `Claude Code failed (${subtype})`)
      return
    }
    // generator throws otherwise / subprocess dies → one transparent restart
    if (!this.crashRestartUsed) {
      this.crashRestartUsed = true
      this.restart(`unexpected exit: ${String(err ?? 'generator ended')}`)
      return
    }
    this.failSession(
      err ? `Claude Code process failed: ${String(err)}` : 'Claude Code process exited unexpectedly',
    )
  }

  /** Transparent restart: fresh query() + InputQueue with resume, re-deliver unanswered input (§2). */
  private restart(reason: string): void {
    this.log.info(
      { sessionId: this.config.sessionId, harnessSessionId: this.harnessSessionId, reason },
      'transparent query() restart',
    )
    this.inputQueue.close() // release the dead query's prompt consumer
    this.mapper.interruptOpenWork() // close events dangling from the dead run
    this.mapper.noteQueryRestart()
    this.startQuery(this.harnessSessionId)
    for (const text of this.unansweredInputs) this.inputQueue.pushText(text)
  }

  private restartIfPending(): void {
    if (!this.needsRestartOnNextInput) return
    this.needsRestartOnNextInput = false
    this.restart('resume after turn/budget limit')
  }

  private failSession(errorText: string): void {
    if (this.endedEmitted) return
    this.pushStatus('failed')
    try {
      this.abort.abort()
    } catch {
      /* noop */
    }
    this.inputQueue.close()
    this.emitEnded({ reason: 'failed', resultSummary: null, errorText })
  }

  /* ------------------------------------------------------------------ input */

  async send(
    input:
      | { kind: 'message'; eventId: string; text: string }
      | { kind: 'slash'; eventId: string; command: string; args: string | null },
  ): Promise<void> {
    this.assertLive()
    this.restartIfPending()
    // §7: slash commands are just prompt text to the SDK; the `slash` transcript
    // event was already persisted control-plane-side — nothing emitted for the send.
    const text =
      input.kind === 'slash' ? `/${input.command}${input.args ? ` ${input.args}` : ''}` : input.text
    this.unansweredInputs.push(text)
    this.inputQueue.pushText(text)
    if (input.kind === 'slash' && input.command === 'clear') {
      // §7: /clear resets context — emit the info event + reset the meter
      this.mapper.onContextCleared()
    }
  }

  async interrupt(): Promise<void> {
    // idempotent no-op when idle (§9)
    if (!this.q || this.endedEmitted || !this.turnActive()) return
    try {
      await this.q.interrupt()
    } catch (err) {
      this.log.debug({ err: String(err) }, 'interrupt() control request failed')
    }
    this.mapper.interruptOpenWork()
    this.pushStatus('awaiting-input')
  }

  permissionVerdict(toolUseId: string, verdict: PermissionVerdict): void {
    this.bridge.verdict(toolUseId, verdict)
  }

  async setModel(model: string): Promise<void> {
    this.assertLive()
    if (!model.startsWith('claude-')) {
      throw new AdapterError(
        'yasui_runner_unsupported_model',
        `claude-code cannot run model "${model}"`,
      )
    }
    this.restartIfPending()
    await (this.q as Query).setModel(model) // streaming-only setter (§4)
    this.emitOutput({
      type: 'event',
      event: {
        id: this.newId(),
        at: nowIso(),
        kind: 'system',
        variant: 'model-change',
        text: `Model changed to ${model}`,
      },
    })
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.assertLive()
    this.restartIfPending()
    await (this.q as Query).setPermissionMode(mode) // immediate for subsequent tool calls (§6)
    this.emitOutput({
      type: 'event',
      event: {
        id: this.newId(),
        at: nowIso(),
        kind: 'system',
        variant: 'info',
        text: `Permission mode set to ${mode}`,
      },
    })
  }

  /* ------------------------------------------------------------------- stop */

  /**
   * §9 grace flow: interrupt → await current result ≤ graceMs → close the input
   * queue → abort as hard-kill backstop → emit 'ended'. The stop reason maps to the
   * wire 'ended' reason (control plane translates reasons → terminal status).
   */
  async stop(reason: 'user' | 'timeout' | 'budget' | 'admin' | 'shutdown'): Promise<void> {
    if (this.endedEmitted) return
    this.stopping = true
    this.log.info({ sessionId: this.config?.sessionId, reason }, 'stopping claude-code session')

    if (this.q) {
      if (this.turnActive()) {
        try {
          await this.q.interrupt()
        } catch (err) {
          this.log.debug({ err: String(err) }, 'interrupt during stop failed')
        }
        await Promise.race([this.nextResult(), sleep(this.graceMs)])
      }
      this.mapper.interruptOpenWork()
      this.inputQueue.close() // stdin EOF — the CLI finishes up and the generator ends
      const finished = await Promise.race([
        (this.runLoopPromise ?? Promise.resolve()).then(() => true),
        sleep(Math.min(1_500, this.graceMs)).then(() => false),
      ])
      if (!finished) {
        // hard-kill backstop (04 §9): abort + close() force-terminate the subprocess
        this.abort.abort()
        try {
          this.q?.close()
        } catch (err) {
          this.log.debug({ err: String(err) }, 'query close during stop failed')
        }
        await Promise.race([this.runLoopPromise ?? Promise.resolve(), sleep(HARD_KILL_BACKSTOP_MS)])
      }
    }

    const summary = this.mapper?.lastSuccessResultText ?? null
    this.emitEnded({
      reason: 'ended',
      resultSummary: summary ? summary.slice(0, RESULT_SUMMARY_MAX) : null,
      errorText: null,
    })
  }

  /* ----------------------------------------------------------------- output */

  output(): AsyncIterable<AdapterOutput> {
    return this.out
  }

  /* ---------------------------------------------------------------- internals */

  private readonly onPreToolUse: HookCallback = async (input) => {
    if ((input as { hook_event_name?: string }).hook_event_name === 'PreToolUse') {
      this.mapper.handlePreToolUse(input as PreToolUseHookInput)
    }
    return {} // never gates — gating is §6
  }

  private readonly onPostToolUse: HookCallback = async (input) => {
    if ((input as { hook_event_name?: string }).hook_event_name === 'PostToolUse') {
      this.mapper.handlePostToolUse(input as PostToolUseHookInput)
    }
    return {}
  }

  private readonly onPostToolUseFailure: HookCallback = async (input) => {
    if ((input as { hook_event_name?: string }).hook_event_name === 'PostToolUseFailure') {
      this.mapper.handlePostToolUseFailure(input as PostToolUseFailureHookInput)
    }
    return {}
  }

  private async refreshContextUsage(): Promise<void> {
    const q = this.q
    if (!q || typeof q.getContextUsage !== 'function') return
    try {
      const usage = await q.getContextUsage()
      if (usage && typeof usage.totalTokens === 'number') {
        this.mapper.setExactContextTokens(usage.totalTokens)
      }
    } catch (err) {
      this.log.debug({ err: String(err) }, 'getContextUsage failed — formula value stands')
    }
  }

  private emitOutput(out: AdapterOutput): void {
    if (this.endedEmitted) {
      this.log.debug({ outType: out.type }, 'output after ended dropped')
      return
    }
    if (out.type === 'status') {
      if (out.status === this.lastStatus) return // consecutive duplicate
      this.lastStatus = out.status
    }
    this.out.push(out)
  }

  private emitEnded(payload: {
    reason: 'completed' | 'failed' | 'interrupted' | 'ended'
    resultSummary: string | null
    errorText: string | null
  }): void {
    if (this.endedEmitted) return
    if (this.mapper) this.mapper.dispose()
    this.out.push({ type: 'ended', ...payload })
    this.endedEmitted = true
    this.out.close()
  }

  private pushStatus(status: 'failed' | 'awaiting-input'): void {
    this.emitOutput({ type: 'status', status })
  }

  private turnActive(): boolean {
    return this.lastStatus !== null && ACTIVE_STATUSES.has(this.lastStatus)
  }

  private nextResult(): Promise<void> {
    return new Promise((resolve) => this.resultWaiters.push(resolve))
  }

  private assertLive(): void {
    if (!this.started) throw new AdapterError('yasui_runner_internal', 'adapter not started')
    if (this.endedEmitted || this.stopping) {
      throw new AdapterError('yasui_runner_internal', 'session has ended')
    }
    if (!this.q && !this.needsRestartOnNextInput) {
      throw new AdapterError('yasui_runner_internal', 'harness process is not running')
    }
  }
}
