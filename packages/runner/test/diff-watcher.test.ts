import { describe, expect, it, vi } from 'vitest'
import type { SessionDiffPayload } from '@yasui.io/runner-protocol'
import { DiffWatcher, MUTATING_TOOLS } from '../src/git/diff-watcher.js'
import type { GitService } from '../src/git/git-service.js'

function makeGit(overrides: Partial<GitService> = {}): GitService {
  return {
    revParseHead: vi.fn(async () => 'baseline-sha'),
    diffSummary: vi.fn(async (): Promise<SessionDiffPayload> => ({ additions: 1, deletions: 0, files: [] })),
    ...overrides,
  } as unknown as GitService
}

const flush = () => new Promise((r) => setTimeout(r, 5))

describe('DiffWatcher (04 §11)', () => {
  it('captures baselineSha at start', async () => {
    const git = makeGit()
    const watcher = new DiffWatcher({ projectPath: '/p', git, emit: () => undefined })
    await watcher.start()
    expect(watcher.baseline).toBe('baseline-sha')
    expect(git.revParseHead).toHaveBeenCalledWith('/p')
  })

  it('null baseline when rev-parse fails (empty repo)', async () => {
    const git = makeGit({ revParseHead: vi.fn(async () => Promise.reject(new Error('no HEAD'))) as never })
    const watcher = new DiffWatcher({ projectPath: '/p', git, emit: () => undefined })
    await watcher.start()
    expect(watcher.baseline).toBeNull()
  })

  it('the mutating tool set is exactly Write|Edit|NotebookEdit|Bash', () => {
    expect([...MUTATING_TOOLS].sort()).toEqual(['Bash', 'Edit', 'NotebookEdit', 'Write'])
  })

  it('debounces bursts into one run against the baseline', async () => {
    vi.useFakeTimers()
    try {
      const emitted: SessionDiffPayload[] = []
      const git = makeGit()
      const watcher = new DiffWatcher({
        projectPath: '/p',
        git,
        emit: (p) => emitted.push(p),
        debounceMs: 750,
        minSpacingMs: 3_000,
      })
      await watcher.start()
      watcher.onToolFinished('Write', true)
      watcher.onToolFinished('Edit', true)
      watcher.onToolFinished('Bash', true)
      await vi.advanceTimersByTimeAsync(749)
      expect(emitted).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(10)
      expect(emitted).toHaveLength(1)
      expect(git.diffSummary).toHaveBeenCalledTimes(1)
      expect(git.diffSummary).toHaveBeenCalledWith('/p', 'baseline-sha')
    } finally {
      vi.useRealTimers()
    }
  })

  it('enforces >= 3 s spacing between emissions', async () => {
    vi.useFakeTimers()
    try {
      const emitted: SessionDiffPayload[] = []
      const watcher = new DiffWatcher({
        projectPath: '/p',
        git: makeGit(),
        emit: (p) => emitted.push(p),
      })
      await watcher.start()
      watcher.onToolFinished('Write', true)
      await vi.advanceTimersByTimeAsync(800)
      expect(emitted).toHaveLength(1)
      // Immediately trigger again — must wait until 3 s since the last emission.
      watcher.onToolFinished('Write', true)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(emitted).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(2_500)
      expect(emitted).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('non-mutating tools do not schedule runs', async () => {
    vi.useFakeTimers()
    try {
      const emitted: SessionDiffPayload[] = []
      const watcher = new DiffWatcher({ projectPath: '/p', git: makeGit(), emit: (p) => emitted.push(p) })
      await watcher.start()
      watcher.onToolFinished('Read', false)
      watcher.onToolFinished('Glob', false)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(emitted).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('runFinal fires immediately (no debounce) and cancels pending timers', async () => {
    const emitted: SessionDiffPayload[] = []
    const watcher = new DiffWatcher({ projectPath: '/p', git: makeGit(), emit: (p) => emitted.push(p) })
    await watcher.start()
    watcher.onToolFinished('Write', true)
    const final = await watcher.runFinal()
    expect(final).toEqual({ additions: 1, deletions: 0, files: [] })
    watcher.stop()
    await flush()
    expect(emitted).toHaveLength(0) // pending debounce was cancelled; final result returned, not emitted
  })

  it('git failures are reported via onError, not thrown', async () => {
    const errors: Error[] = []
    const git = makeGit({ diffSummary: vi.fn(async () => Promise.reject(new Error('boom'))) as never })
    const watcher = new DiffWatcher({
      projectPath: '/p',
      git,
      emit: () => undefined,
      onError: (e) => errors.push(e),
    })
    await watcher.start()
    const final = await watcher.runFinal()
    expect(final).toBeNull()
    expect(errors[0]?.message).toBe('boom')
  })
})
