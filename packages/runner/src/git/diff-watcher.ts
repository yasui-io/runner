/**
 * DiffWatcher — debounced `session.diff` frames (04 §11).
 *
 * Per session: at session.start, record `baselineSha = git rev-parse HEAD` of
 * the session cwd (agent-made commits still show in the diff rail until
 * pushed/discarded). On every `tool-finished` adapter output with a mutating
 * tool (Write|Edit|NotebookEdit|Bash — Decision: Bash always counts), schedule
 * a run: 750 ms debounce, ≥ 3 s between emissions (matches 02 §7's ≤ 1 per
 * 3 s). A final non-debounced run fires right before `session.ended`.
 */

import type { SessionDiffPayload } from '@yasui.io/runner-protocol'
import type { GitService } from './git-service.js'

export const MUTATING_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit', 'Bash'])
export const DIFF_DEBOUNCE_MS = 750
export const DIFF_MIN_SPACING_MS = 3_000

export interface DiffWatcherOptions {
  projectPath: string
  git: GitService
  emit: (payload: SessionDiffPayload) => void
  onError?: (err: Error) => void
  /** Injectable clock for tests. */
  now?: () => number
  debounceMs?: number
  minSpacingMs?: number
}

export class DiffWatcher {
  private baselineSha: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastEmitAt = 0
  private running = false
  private pendingWhileRunning = false
  private stopped = false
  private readonly now: () => number
  private readonly debounceMs: number
  private readonly minSpacingMs: number

  constructor(private readonly opts: DiffWatcherOptions) {
    this.now = opts.now ?? Date.now
    this.debounceMs = opts.debounceMs ?? DIFF_DEBOUNCE_MS
    this.minSpacingMs = opts.minSpacingMs ?? DIFF_MIN_SPACING_MS
  }

  get baseline(): string | null {
    return this.baselineSha
  }

  /** Capture the baseline sha. Repos with zero commits get a null baseline (diff vs HEAD later). */
  async start(): Promise<void> {
    try {
      this.baselineSha = await this.opts.git.revParseHead(this.opts.projectPath)
    } catch {
      this.baselineSha = null
    }
  }

  /** Adapter `tool-finished` hook (04 §9 → §11). */
  onToolFinished(toolName: string, mutating: boolean): void {
    if (this.stopped) return
    if (!mutating && !MUTATING_TOOLS.has(toolName)) return
    this.schedule()
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    const sinceLast = this.now() - this.lastEmitAt
    const wait = Math.max(this.debounceMs, this.minSpacingMs - sinceLast)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run()
    }, wait)
    // Never keep the process alive for a pending diff.
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref()
  }

  private async run(): Promise<void> {
    if (this.stopped) return
    if (this.running) {
      this.pendingWhileRunning = true
      return
    }
    this.running = true
    try {
      const payload = await this.opts.git.diffSummary(this.opts.projectPath, this.baselineSha ?? undefined)
      this.lastEmitAt = this.now()
      if (!this.stopped) this.opts.emit(payload)
    } catch (err) {
      this.opts.onError?.(err as Error)
    } finally {
      this.running = false
      if (this.pendingWhileRunning && !this.stopped) {
        this.pendingWhileRunning = false
        this.schedule()
      }
    }
  }

  /** Final non-debounced run right before session.ended (04 §11). */
  async runFinal(): Promise<SessionDiffPayload | null> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    try {
      const payload = await this.opts.git.diffSummary(this.opts.projectPath, this.baselineSha ?? undefined)
      this.lastEmitAt = this.now()
      return payload
    } catch (err) {
      this.opts.onError?.(err as Error)
      return null
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
