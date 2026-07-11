import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  GitService,
  GitServiceError,
  githubWebUrl,
  parseFileDiff,
  parseNumstat,
  parsePorcelainV2,
  parseWorktreePorcelain,
  type ExecResult,
  type GitExec,
} from '../src/git/git-service.js'

/* ---------- parser tests (fixture strings, no git needed) ---------- */

describe('parsePorcelainV2', () => {
  const sample = [
    '# branch.oid 1234567890abcdef',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb src/router.ts',
    '1 M. N... 100644 100644 100644 aaa bbb src/staged.ts',
    '1 MM N... 100644 100644 100644 aaa bbb src/both.ts',
    '2 R. N... 100644 100644 100644 aaa bbb R100 src/new-name.ts\tsrc/old-name.ts',
    '? src/untracked.ts',
    '',
  ].join('\n')

  it('parses branch header, upstream, ahead/behind', () => {
    const result = parsePorcelainV2(sample)
    expect(result.branch).toBe('main')
    expect(result.upstream).toBe('origin/main')
    expect(result.ahead).toBe(2)
    expect(result.behind).toBe(1)
    expect(result.dirty).toBe(true)
  })

  it('classifies staged/unstaged/untracked (files in both XY positions land in both)', () => {
    const result = parsePorcelainV2(sample)
    expect(result.unstaged).toContain('src/router.ts')
    expect(result.staged).toContain('src/staged.ts')
    expect(result.staged).toContain('src/both.ts')
    expect(result.unstaged).toContain('src/both.ts')
    expect(result.staged).toContain('src/new-name.ts')
    expect(result.untracked).toEqual(['src/untracked.ts'])
  })

  it('null upstream when unset; clean tree is not dirty', () => {
    const clean = parsePorcelainV2('# branch.oid abc\n# branch.head main\n')
    expect(clean.upstream).toBeNull()
    expect(clean.dirty).toBe(false)
    expect(clean.ahead).toBe(0)
  })

  it('detached HEAD becomes HEAD', () => {
    expect(parsePorcelainV2('# branch.head (detached)\n').branch).toBe('HEAD')
  })
})

describe('parseNumstat', () => {
  it('parses additions/deletions/paths', () => {
    const entries = parseNumstat('96\t30\tsrc/router.ts\n32\t11\tsrc/router.test.ts\n')
    expect(entries).toEqual([
      { path: 'src/router.ts', additions: 96, deletions: 30 },
      { path: 'src/router.test.ts', additions: 32, deletions: 11 },
    ])
  })

  it('binary files (-) count as zero', () => {
    expect(parseNumstat('-\t-\tassets/logo.png\n')).toEqual([{ path: 'assets/logo.png', additions: 0, deletions: 0 }])
  })

  it('braced rename form', () => {
    const entries = parseNumstat('5\t2\tsrc/{old => new}/mod.ts\n')
    expect(entries[0]).toEqual({ path: 'src/new/mod.ts', additions: 5, deletions: 2, renamedFrom: 'src/old/mod.ts' })
  })

  it('arrow rename form', () => {
    const entries = parseNumstat('1\t1\told.ts => new.ts\n')
    expect(entries[0]).toEqual({ path: 'new.ts', additions: 1, deletions: 1, renamedFrom: 'old.ts' })
  })
})

describe('parseFileDiff (hunk parser)', () => {
  const sample = [
    'diff --git a/src/router.ts b/src/router.ts',
    'index 111..222 100644',
    '--- a/src/router.ts',
    '+++ b/src/router.ts',
    '@@ -12,6 +12,9 @@ export function router() {',
    " import { Hono } from 'hono'",
    "+import { z } from 'zod'",
    '+const schema = z.object({})',
    '-const legacy = true',
    ' const app = new Hono()',
    '@@ -40,2 +43,2 @@',
    '-old line',
    '+new line',
    '',
  ].join('\n')

  it('parses hunk headers and add/del/ctx lines', () => {
    const diff = parseFileDiff(sample, 'src/router.ts')
    expect(diff.status).toBe('modified')
    expect(diff.hunks).toHaveLength(2)
    expect(diff.hunks[0]?.header).toBe('@@ -12,6 +12,9 @@')
    expect(diff.hunks[0]?.lines).toEqual([
      { kind: 'ctx', text: "import { Hono } from 'hono'" },
      { kind: 'add', text: "import { z } from 'zod'" },
      { kind: 'add', text: 'const schema = z.object({})' },
      { kind: 'del', text: 'const legacy = true' },
      { kind: 'ctx', text: 'const app = new Hono()' },
    ])
    expect(diff.additions).toBe(3)
    expect(diff.deletions).toBe(2)
    expect(diff.truncated).toBeUndefined()
  })

  it('detects added/deleted status from mode lines', () => {
    expect(parseFileDiff('new file mode 100644\n@@ -0,0 +1 @@\n+hello\n', 'a.ts').status).toBe('added')
    expect(parseFileDiff('deleted file mode 100644\n@@ -1 +0,0 @@\n-bye\n', 'b.ts').status).toBe('deleted')
    expect(parseFileDiff('rename from a\nrename to b\n@@ -1 +1 @@\n-x\n+y\n', 'b.ts').status).toBe('renamed')
  })

  it('truncates past 512 KiB with truncated: true', () => {
    const bigLine = '+' + 'x'.repeat(1024)
    const lines = ['@@ -1,1 +1,600 @@', ...Array.from({ length: 700 }, () => bigLine)]
    const diff = parseFileDiff(lines.join('\n'), 'big.ts')
    expect(diff.truncated).toBe(true)
    expect(diff.additions).toBe(700) // totals still counted past the cut
    const serialized = JSON.stringify(diff.hunks)
    expect(Buffer.byteLength(serialized)).toBeLessThan(600 * 1024)
  })

  it('ignores "\\ No newline at end of file"', () => {
    const diff = parseFileDiff('@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n', 'x.ts')
    expect(diff.hunks[0]?.lines).toHaveLength(2)
  })
})

describe('parseWorktreePorcelain', () => {
  it('parses main + linked worktrees + detached', () => {
    const sample = [
      'worktree /Users/kai/dev/acme-api',
      'HEAD 1234567890abcdef',
      'branch refs/heads/main',
      '',
      'worktree /Users/kai/dev/acme-api/.yasui-worktrees/fix-router',
      'HEAD abcdef1234567890',
      'branch refs/heads/yasui/fix-router',
      '',
      'worktree /Users/kai/dev/detached-wt',
      'HEAD fedcba0987654321',
      'detached',
      '',
    ].join('\n')
    const entries = parseWorktreePorcelain(sample)
    expect(entries).toHaveLength(3)
    expect(entries[0]).toEqual({ path: '/Users/kai/dev/acme-api', branch: 'main', detached: false })
    expect(entries[1]?.branch).toBe('yasui/fix-router')
    expect(entries[2]?.detached).toBe(true)
  })
})

describe('githubWebUrl', () => {
  it('ssh remote', () => {
    expect(githubWebUrl('git@github.com:acme/api.git', 'main')).toBe('https://github.com/acme/api/tree/main')
  })
  it('https remote', () => {
    expect(githubWebUrl('https://github.com/acme/api', 'fix/x')).toBe('https://github.com/acme/api/tree/fix%2Fx')
  })
  it('non-github remotes yield undefined', () => {
    expect(githubWebUrl('git@gitlab.com:acme/api.git', 'main')).toBeUndefined()
  })
})

/* ---------- argv template tests (mock exec — whitelist per 04 §10) ---------- */

function recordingService(tmpRoot: string, replies: Record<string, ExecResult> = {}) {
  const calls: Array<{ args: string[]; cwd: string; timeoutMs: number }> = []
  const exec: GitExec = async (args, cwd, timeoutMs) => {
    calls.push({ args, cwd, timeoutMs })
    const key = args.join(' ')
    for (const [prefix, reply] of Object.entries(replies)) {
      if (key.startsWith(prefix)) return reply
    }
    return { stdout: '', stderr: '', code: 0 }
  }
  const service = new GitService({ roots: () => [tmpRoot], exec })
  return { service, calls }
}

describe('GitService argv templates + guards', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yasui-git-argv-'))
  const repo = path.join(tmpRoot, 'proj')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })

  it('status uses the exact porcelain v2 argv', async () => {
    const { service, calls } = recordingService(tmpRoot, {
      'status --porcelain=v2 --branch': { stdout: '# branch.head main\n', stderr: '', code: 0 },
    })
    await service.status(repo)
    expect(calls[0]?.args).toEqual(['status', '--porcelain=v2', '--branch'])
    expect(calls[0]?.timeoutMs).toBe(30_000)
  })

  it('commit adds with -- separator and passes the message as one argv element', async () => {
    const { service, calls } = recordingService(tmpRoot, {
      commit: { stdout: ' 2 files changed, 3 insertions(+)\n', stderr: '', code: 0 },
      'rev-parse HEAD': { stdout: 'abc123\n', stderr: '', code: 0 },
      'branch --show-current': { stdout: 'main\n', stderr: '', code: 0 },
    })
    const message = 'multi word\n\nwith newlines; $(dangerous) `stuff`'
    const result = await service.commit(repo, message, ['-weird-name.ts'])
    expect(calls[0]?.args).toEqual(['add', '-A', '--', '-weird-name.ts'])
    expect(calls[1]?.args).toEqual(['commit', '-m', message])
    expect(result.sha).toBe('abc123')
    expect(result.filesCommitted).toBe(2)
  })

  it('push uses HEAD + optional --set-upstream and the 120 s timeout', async () => {
    const { service, calls } = recordingService(tmpRoot, {
      'branch --show-current': { stdout: 'main\n', stderr: '', code: 0 },
      'remote get-url origin': { stdout: 'git@github.com:acme/api.git\n', stderr: '', code: 0 },
    })
    const result = await service.push(repo, 'origin', true)
    const pushCall = calls.find((c) => c.args[0] === 'push')
    expect(pushCall?.args).toEqual(['push', '--set-upstream', 'origin', 'HEAD'])
    expect(pushCall?.timeoutMs).toBe(120_000)
    expect(result.url).toBe('https://github.com/acme/api/tree/main')
  })

  it('worktree.create argv matches the template', async () => {
    const { service, calls } = recordingService(tmpRoot)
    await service.worktreeCreate(repo, 'fix-router')
    const realRepo = fs.realpathSync(repo)
    expect(calls[0]?.args).toEqual([
      'worktree',
      'add',
      path.join(realRepo, '.yasui-worktrees', 'fix-router'),
      '-b',
      'yasui/fix-router',
    ])
  })

  it('rejects worktree names with separators or leading dashes (arg-rejected)', async () => {
    const { service } = recordingService(tmpRoot)
    await expect(service.worktreeCreate(repo, '../escape')).rejects.toThrowError(GitServiceError)
    await expect(service.worktreeCreate(repo, '--force')).rejects.toThrowError(GitServiceError)
  })

  it('rejects refs with leading dashes', async () => {
    const { service } = recordingService(tmpRoot)
    await expect(service.diffSummary(repo, '--exec=/bin/sh')).rejects.toThrowError(GitServiceError)
  })

  it('rejects absolute and escaping file paths', async () => {
    const { service } = recordingService(tmpRoot)
    await expect(service.diffFile(repo, '/etc/passwd')).rejects.toThrowError(GitServiceError)
    await expect(service.diffFile(repo, '../../outside.ts')).rejects.toThrowError(GitServiceError)
  })

  it('path confinement: repos outside roots are yasui_runner_project_not_found', async () => {
    const { service } = recordingService(tmpRoot)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'yasui-outside-'))
    try {
      await expect(service.status(outside)).rejects.toMatchObject({ code: 'yasui_runner_project_not_found' })
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('symlink escapes fail the realpath check', async () => {
    const { service } = recordingService(tmpRoot)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'yasui-symlink-target-'))
    const link = path.join(tmpRoot, 'sneaky')
    fs.symlinkSync(outside, link)
    try {
      await expect(service.status(link)).rejects.toMatchObject({ code: 'yasui_runner_project_not_found' })
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
      fs.unlinkSync(link)
    }
  })

  it('handleRequest wraps failures as git.result ok:false with capped stderr', async () => {
    const bigStderr = 'e'.repeat(20_000)
    const { service } = recordingService(tmpRoot, {
      'status --porcelain=v2 --branch': { stdout: '', stderr: bigStderr, code: 128 },
    })
    const result = await service.handleRequest({ opId: 'op_1', op: 'status', args: { path: repo } })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error.code).toBe('yasui_runner_git_failed')
    expect(result.error.stderr?.length).toBeLessThanOrEqual(8 * 1024)
  })
})

/* ---------- real-git integration (git exists on this machine) ---------- */

describe('GitService against a real repo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yasui-git-real-'))
  const repo = path.join(root, 'realproj')

  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
      .toString()

  it('setup: init + commit', () => {
    fs.mkdirSync(repo, { recursive: true })
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'line1\nline2\n')
    git('add', '-A')
    git('commit', '-m', 'initial')
  })

  it('status on a clean repo', async () => {
    const service = new GitService({ roots: () => [root] })
    const status = await service.status(repo)
    expect(status.branch).toBe('main')
    expect(status.dirty).toBe(false)
    expect(status.upstream).toBeNull()
  })

  it('diff summary picks up modified + untracked files', async () => {
    const service = new GitService({ roots: () => [root] })
    fs.writeFileSync(path.join(repo, 'a.txt'), 'line1\nline2 changed\nline3\n')
    fs.writeFileSync(path.join(repo, 'new.txt'), 'brand\nnew\n')
    const diff = await service.diffSummary(repo)
    const paths = diff.files.map((f) => f.path).sort()
    expect(paths).toEqual(['a.txt', 'new.txt'])
    const untracked = diff.files.find((f) => f.path === 'new.txt')
    expect(untracked?.status).toBe('added')
    expect(untracked?.additions).toBe(2)
    expect(diff.additions).toBeGreaterThanOrEqual(3)
  })

  it('diff.file returns hunks for tracked and untracked files', async () => {
    const service = new GitService({ roots: () => [root] })
    const tracked = await service.diffFile(repo, 'a.txt')
    expect(tracked.hunks.length).toBeGreaterThan(0)
    expect(tracked.hunks[0]?.lines.some((l) => l.kind === 'add')).toBe(true)
    const untracked = await service.diffFile(repo, 'new.txt')
    expect(untracked.status).toBe('added')
    expect(untracked.additions).toBe(2)
  })

  it('commit stages everything and reports sha/branch', async () => {
    const service = new GitService({ roots: () => [root] })
    const result = await service.commit(repo, 'test commit from GitService')
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(result.branch).toBe('main')
    expect((await service.status(repo)).dirty).toBe(false)
  })

  it('discard removes modifications and untracked files', async () => {
    const service = new GitService({ roots: () => [root] })
    fs.writeFileSync(path.join(repo, 'a.txt'), 'dirty again\n')
    fs.writeFileSync(path.join(repo, 'junk.txt'), 'junk\n')
    const result = await service.discard(repo)
    expect(result.discarded.sort()).toEqual(['a.txt', 'junk.txt'])
    expect((await service.status(repo)).dirty).toBe(false)
    expect(fs.existsSync(path.join(repo, 'junk.txt'))).toBe(false)
  })

  it('worktree create/list/remove round-trip', async () => {
    const service = new GitService({ roots: () => [root] })
    const created = await service.worktreeCreate(repo, 'feature-x')
    expect(created.worktree.branch).toBe('yasui/feature-x')
    expect(fs.existsSync(created.worktree.path)).toBe(true)
    const list = await service.worktreeList(repo)
    expect(list.worktrees.some((w) => w.branch === 'yasui/feature-x')).toBe(true)
    const removed = await service.worktreeRemove(repo, 'feature-x', true)
    expect(removed.removed).toBe(true)
  })

  it('cleanup', () => {
    fs.rmSync(root, { recursive: true, force: true })
  })
})
