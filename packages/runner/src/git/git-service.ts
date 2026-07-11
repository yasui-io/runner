/**
 * GitService — whitelisted typed git (04 §10, 08 §4).
 *
 * All git runs through `execFile('git', args, { cwd, timeout, maxBuffer })` —
 * never a shell, never string-concatenated commands. The control plane sends
 * typed `git.request` ops (02 §8) and each op maps to a FIXED argv template
 * below; anything outside the whitelist is unrepresentable.
 *
 * Guards:
 *  - every `path`/`file` arg is realpath'd and must stay under a configured
 *    root (reject `yasui_runner_project_not_found`);
 *  - `-`/`--`-prefixed file names are always preceded by a literal `--`;
 *  - env for child git = { ...process.env, GIT_TERMINAL_PROMPT: '0',
 *    GIT_OPTIONAL_LOCKS: '0', GIT_ASKPASS: '/bin/false' };
 *  - timeouts 30 s (push 120 s); stderr capped at 8 KiB.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { RELAY_LIMITS, RELAY_ERROR_CODES } from '@yasui.io/runner-protocol'
import type {
  DiffHunk,
  DiffLine,
  FileDiff,
  GitCommitResult,
  GitDiffFileResult,
  GitDiffResult,
  GitDiscardResult,
  GitRequestPayload,
  GitResultPayload,
  GitStatusResult,
  Worktree,
  WorktreeCreateResult,
  WorktreeListResult,
  WorktreeRemoveResult,
} from '@yasui.io/runner-protocol'

export const GIT_TIMEOUT_MS = 30_000
export const GIT_PUSH_TIMEOUT_MS = 120_000
export const GIT_STDERR_CAP = 8 * 1024
const MAX_BUFFER = 64 * 1024 * 1024

export class GitServiceError extends Error {
  constructor(
    message: string,
    readonly code: string = RELAY_ERROR_CODES.runnerGitFailed,
    readonly stderr = '',
    readonly reason?: string,
  ) {
    super(message)
    this.name = 'GitServiceError'
  }
}

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

export type GitExec = (args: string[], cwd: string, timeoutMs: number) => Promise<ExecResult>

const defaultExec: GitExec = (args, cwd, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_ASKPASS: '/bin/false',
        },
        killSignal: 'SIGTERM',
      },
      (error, stdout, stderr) => {
        const code = error ? ((error as NodeJS.ErrnoException & { code?: number | string }).code as number | undefined) : 0
        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          code: typeof code === 'number' ? code : error ? 1 : 0,
        })
      },
    )
  })

const capStderr = (stderr: string) => (stderr.length > GIT_STDERR_CAP ? stderr.slice(0, GIT_STDERR_CAP) : stderr)

/** Worktree/branch names accepted from the wire: no separators, no leading `-`. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** Refs for `base`/`branch` args: ref-ish characters only, never `-`-leading. */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,127}$/

export interface GitServiceOptions {
  /** Configured project roots — path confinement boundary (08 §4). */
  roots: () => string[]
  exec?: GitExec
}

export class GitService {
  private readonly exec: GitExec

  constructor(private readonly opts: GitServiceOptions) {
    this.exec = opts.exec ?? defaultExec
  }

  /* ---------- Path confinement ---------- */

  /** realpath + prefix-match under a configured root (symlink escapes fail). */
  confineProjectPath(projectPath: string): string {
    let real: string
    try {
      real = fs.realpathSync(projectPath)
    } catch {
      throw new GitServiceError(`path does not exist: ${projectPath}`, RELAY_ERROR_CODES.runnerProjectNotFound)
    }
    const roots = this.opts.roots()
    for (const root of roots) {
      let realRoot: string
      try {
        realRoot = fs.realpathSync(root)
      } catch {
        continue
      }
      if (real === realRoot || real.startsWith(realRoot + path.sep)) return real
    }
    throw new GitServiceError(
      `path is not under a configured project root: ${projectPath}`,
      RELAY_ERROR_CODES.runnerProjectNotFound,
    )
  }

  /** Repo-relative file path: lexically confined to the repo, `--`-separated in argv. */
  private confineFile(repo: string, file: string): string {
    if (file.length === 0 || path.isAbsolute(file)) {
      throw new GitServiceError(`file path rejected: ${file}`, RELAY_ERROR_CODES.runnerGitFailed, '', 'arg-rejected')
    }
    const resolved = path.resolve(repo, file)
    if (resolved !== repo && !resolved.startsWith(repo + path.sep)) {
      throw new GitServiceError(`file path escapes the repo: ${file}`, RELAY_ERROR_CODES.runnerGitFailed, '', 'arg-rejected')
    }
    return file
  }

  private requireRef(ref: string): string {
    if (!SAFE_REF.test(ref)) {
      throw new GitServiceError(`ref rejected: ${ref}`, RELAY_ERROR_CODES.runnerGitFailed, '', 'arg-rejected')
    }
    return ref
  }

  private requireName(name: string): string {
    if (!SAFE_NAME.test(name)) {
      throw new GitServiceError(`name rejected: ${name}`, RELAY_ERROR_CODES.runnerGitFailed, '', 'arg-rejected')
    }
    return name
  }

  private async run(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<ExecResult> {
    const result = await this.exec(args, cwd, timeoutMs)
    return { ...result, stderr: capStderr(result.stderr) }
  }

  private async runOk(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
    const result = await this.run(args, cwd, timeoutMs)
    if (result.code !== 0) {
      throw new GitServiceError(`git ${args[0]} failed (exit ${result.code})`, RELAY_ERROR_CODES.runnerGitFailed, result.stderr)
    }
    return result.stdout
  }

  /* ---------- Ops (02 §8 table) ---------- */

  async status(projectPath: string): Promise<GitStatusResult> {
    const repo = this.confineProjectPath(projectPath)
    const out = await this.runOk(['status', '--porcelain=v2', '--branch'], repo)
    return parsePorcelainV2(out)
  }

  /** `diff` summary: numstat vs base + porcelain for untracked; empty hunks. */
  async diffSummary(projectPath: string, base?: string): Promise<GitDiffResult> {
    const repo = this.confineProjectPath(projectPath)
    const baseRef = base ? this.requireRef(base) : undefined
    const numstatArgs = baseRef ? ['diff', '--numstat', baseRef] : ['diff', '--numstat', 'HEAD']
    const numstatOut = await this.run(numstatArgs, repo)
    // A repo with zero commits has no HEAD — treat everything as untracked.
    const tracked = numstatOut.code === 0 ? parseNumstat(numstatOut.stdout) : []

    const repoStatus = parsePorcelainV2(await this.runOk(['status', '--porcelain=v2', '--branch'], repo))
    const files: FileDiff[] = []
    let additions = 0
    let deletions = 0
    for (const entry of tracked) {
      const exists = fs.existsSync(path.join(repo, entry.path))
      const fileStatus: FileDiff['status'] = !exists ? 'deleted' : entry.renamedFrom ? 'renamed' : 'modified'
      files.push({ path: entry.path, status: fileStatus, additions: entry.additions, deletions: entry.deletions, hunks: [] })
      additions += entry.additions
      deletions += entry.deletions
    }
    for (const untracked of repoStatus.untracked) {
      if (files.some((f) => f.path === untracked)) continue
      let adds = 0
      try {
        const res = await this.run(['diff', '--numstat', '--no-index', '--', '/dev/null', untracked], repo)
        // --no-index exits 1 when the files differ — that is the success path.
        const parsed = parseNumstat(res.stdout)
        adds = parsed[0]?.additions ?? 0
      } catch {
        adds = 0
      }
      files.push({ path: untracked, status: 'added', additions: adds, deletions: 0, hunks: [] })
      additions += adds
    }
    return { additions, deletions, files }
  }

  /** `diff.file`: one FileDiff with parsed hunks, truncated past 512 KiB. */
  async diffFile(projectPath: string, file: string, base?: string): Promise<GitDiffFileResult> {
    const repo = this.confineProjectPath(projectPath)
    const rel = this.confineFile(repo, file)
    const baseRef = base ? this.requireRef(base) : undefined
    const tracked = await this.run(['ls-files', '--error-unmatch', '--', rel], repo)
    const isUntracked = tracked.code !== 0

    let out: string
    if (isUntracked) {
      const res = await this.run(['diff', '-U3', '--no-index', '--', '/dev/null', rel], repo)
      if (res.code !== 0 && res.code !== 1) {
        throw new GitServiceError('git diff --no-index failed', RELAY_ERROR_CODES.runnerGitFailed, res.stderr)
      }
      out = res.stdout
    } else {
      const args = baseRef ? ['diff', '-U3', baseRef, '--', rel] : ['diff', '-U3', 'HEAD', '--', rel]
      out = await this.runOk(args, repo)
    }
    return parseFileDiff(out, rel, isUntracked ? 'added' : undefined)
  }

  async commit(projectPath: string, message: string, files?: string[]): Promise<GitCommitResult> {
    const repo = this.confineProjectPath(projectPath)
    if (message.length === 0) {
      throw new GitServiceError('empty commit message', RELAY_ERROR_CODES.runnerGitFailed, '', 'arg-rejected')
    }
    const targets = files && files.length > 0 ? files.map((f) => this.confineFile(repo, f)) : ['.']
    await this.runOk(['add', '-A', '--', ...targets], repo)
    const commitOut = await this.runOk(['commit', '-m', message], repo)
    const sha = (await this.runOk(['rev-parse', 'HEAD'], repo)).trim()
    const branch = (await this.runOk(['branch', '--show-current'], repo)).trim()
    const filesMatch = commitOut.match(/(\d+) files? changed/)
    return { sha, branch, filesCommitted: filesMatch ? Number(filesMatch[1]) : targets.length }
  }

  async push(projectPath: string, remote = 'origin', setUpstream = false): Promise<{ remote: string; branch: string; url?: string }> {
    const repo = this.confineProjectPath(projectPath)
    this.requireName(remote)
    const branch = (await this.runOk(['branch', '--show-current'], repo)).trim()
    const args = setUpstream ? ['push', '--set-upstream', remote, 'HEAD'] : ['push', remote, 'HEAD']
    await this.runOk(args, repo, GIT_PUSH_TIMEOUT_MS)
    let url: string | undefined
    try {
      const remoteUrl = (await this.runOk(['remote', 'get-url', remote], repo)).trim()
      url = githubWebUrl(remoteUrl, branch)
    } catch {
      url = undefined
    }
    return { remote, branch, ...(url ? { url } : {}) }
  }

  async discard(projectPath: string, files?: string[]): Promise<GitDiscardResult> {
    const repo = this.confineProjectPath(projectPath)
    const before = parsePorcelainV2(await this.runOk(['status', '--porcelain=v2', '--branch'], repo))
    const dirty = new Set([...before.staged, ...before.unstaged, ...before.untracked])
    let targets: string[]
    let discarded: string[]
    if (files && files.length > 0) {
      targets = files.map((f) => this.confineFile(repo, f))
      discarded = targets.filter((f) => dirty.has(f))
    } else {
      targets = ['.']
      discarded = [...dirty]
    }
    // checkout restores tracked modifications; clean removes untracked files.
    const co = await this.run(['checkout', '--', ...targets], repo)
    if (co.code !== 0 && !/did not match any file/.test(co.stderr)) {
      throw new GitServiceError('git checkout failed', RELAY_ERROR_CODES.runnerGitFailed, co.stderr)
    }
    await this.runOk(['clean', '-fd', '--', ...targets], repo)
    return { discarded: discarded.sort() }
  }

  async worktreeList(projectPath: string): Promise<WorktreeListResult> {
    const repo = this.confineProjectPath(projectPath)
    const out = await this.runOk(['worktree', 'list', '--porcelain'], repo)
    const parsed = parseWorktreePorcelain(out)
    const worktrees: Worktree[] = []
    for (const entry of parsed) {
      let dirty = false
      try {
        const status = await this.runOk(['status', '--porcelain=v2'], entry.path)
        dirty = status.trim().length > 0
      } catch {
        dirty = false
      }
      worktrees.push({
        name: path.basename(entry.path),
        branch: entry.branch,
        path: entry.path,
        dirty,
        current: entry.path === repo,
      })
    }
    return { worktrees }
  }

  worktreePathFor(projectPath: string, name: string): string {
    return path.join(projectPath, '.yasui-worktrees', name)
  }

  async worktreeCreate(projectPath: string, name: string, branch?: string): Promise<WorktreeCreateResult> {
    const repo = this.confineProjectPath(projectPath)
    this.requireName(name)
    const wtPath = this.worktreePathFor(repo, name)
    const args = ['worktree', 'add', wtPath, '-b', `yasui/${name}`]
    if (branch) args.push(this.requireRef(branch))
    await this.runOk(args, repo)
    return {
      worktree: { name, branch: `yasui/${name}`, path: wtPath, dirty: false, current: false },
    }
  }

  async worktreeRemove(projectPath: string, name: string, force = false): Promise<WorktreeRemoveResult> {
    const repo = this.confineProjectPath(projectPath)
    this.requireName(name)
    const wtPath = this.worktreePathFor(repo, name)
    const args = force ? ['worktree', 'remove', '--force', wtPath] : ['worktree', 'remove', wtPath]
    await this.runOk(args, repo)
    if (force) {
      const res = await this.run(['branch', '-D', `yasui/${name}`], repo)
      if (res.code !== 0) {
        // Branch already gone is fine; anything else is logged by the caller via stderr.
      }
    }
    return { removed: true }
  }

  /* ---------- Helpers used by discovery / diff watcher / session start ---------- */

  async revParseHead(projectPath: string): Promise<string> {
    const repo = this.confineProjectPath(projectPath)
    return (await this.runOk(['rev-parse', 'HEAD'], repo)).trim()
  }

  async currentBranch(projectPath: string): Promise<string> {
    const repo = this.confineProjectPath(projectPath)
    return (await this.runOk(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).trim()
  }

  async isDirty(projectPath: string): Promise<boolean> {
    const repo = this.confineProjectPath(projectPath)
    const out = await this.runOk(['status', '--porcelain=v2'], repo)
    return out.trim().length > 0
  }

  async remoteUrl(projectPath: string): Promise<string | null> {
    const repo = this.confineProjectPath(projectPath)
    const res = await this.run(['remote', 'get-url', 'origin'], repo)
    return res.code === 0 ? res.stdout.trim() || null : null
  }

  async lastCommitAt(projectPath: string): Promise<string | null> {
    const repo = this.confineProjectPath(projectPath)
    const res = await this.run(['log', '-1', '--format=%cI'], repo)
    return res.code === 0 ? res.stdout.trim() || null : null
  }

  /* ---------- git.request dispatch (02 §8 → §7 git.result) ---------- */

  async handleRequest(payload: GitRequestPayload): Promise<GitResultPayload> {
    const { opId, op } = payload
    try {
      switch (payload.op) {
        case 'status':
          return { opId, op: 'status', ok: true, result: await this.status(payload.args.path) }
        case 'diff':
          return { opId, op: 'diff', ok: true, result: await this.diffSummary(payload.args.path, payload.args.base) }
        case 'diff.file':
          return {
            opId,
            op: 'diff.file',
            ok: true,
            result: await this.diffFile(payload.args.path, payload.args.file, payload.args.base),
          }
        case 'commit':
          return {
            opId,
            op: 'commit',
            ok: true,
            result: await this.commit(payload.args.path, payload.args.message, payload.args.files),
          }
        case 'push':
          return {
            opId,
            op: 'push',
            ok: true,
            result: await this.push(payload.args.path, payload.args.remote ?? 'origin', payload.args.setUpstream ?? false),
          }
        case 'discard':
          return { opId, op: 'discard', ok: true, result: await this.discard(payload.args.path, payload.args.files) }
        case 'worktree.list':
          return { opId, op: 'worktree.list', ok: true, result: await this.worktreeList(payload.args.path) }
        case 'worktree.create':
          return {
            opId,
            op: 'worktree.create',
            ok: true,
            result: await this.worktreeCreate(payload.args.path, payload.args.name, payload.args.branch),
          }
        case 'worktree.remove':
          return {
            opId,
            op: 'worktree.remove',
            ok: true,
            result: await this.worktreeRemove(payload.args.path, payload.args.name, payload.args.force ?? false),
          }
      }
    } catch (err) {
      const e = err instanceof GitServiceError ? err : new GitServiceError((err as Error).message)
      return {
        opId,
        op,
        ok: false,
        error: {
          code: e.code,
          message: e.message,
          ...(e.stderr ? { stderr: e.stderr } : {}),
        },
      }
    }
    // Unreachable (switch is exhaustive), but keeps TS + runtime honest for
    // forward-compat ops that zod let through.
    return {
      opId,
      op,
      ok: false,
      error: { code: RELAY_ERROR_CODES.runnerGitFailed, message: `unsupported git op: ${op}` },
    }
  }
}

/* ---------- Parsers (pure, unit-tested against fixture strings) ---------- */

/** `git status --porcelain=v2 --branch` → typed status (02 §8). */
export function parsePorcelainV2(text: string): GitStatusResult {
  let branch = ''
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const staged: string[] = []
  const unstaged: string[] = []
  const untracked: string[] = []

  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim()
      if (branch === '(detached)') branch = 'HEAD'
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim() || null
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/)
      if (m) {
        ahead = Number(m[1])
        behind = Number(m[2])
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // 1 XY sub mH mI mW hH hI path
      // 2 XY sub mH mI mW hH hI Xscore path\torigPath
      const parts = line.split(' ')
      const xy = parts[1] ?? '..'
      const fieldCount = line.startsWith('1 ') ? 8 : 9
      let rest = parts.slice(fieldCount).join(' ')
      if (line.startsWith('2 ')) rest = rest.split('\t')[0] ?? rest
      if (rest.length === 0) continue
      if (xy[0] !== '.') staged.push(rest)
      if (xy[1] !== '.') unstaged.push(rest)
    } else if (line.startsWith('u ')) {
      // unmerged — surfaces as unstaged
      const parts = line.split(' ')
      const rest = parts.slice(10).join(' ')
      if (rest) unstaged.push(rest)
    } else if (line.startsWith('? ')) {
      untracked.push(line.slice(2))
    }
  }

  return {
    branch,
    upstream,
    dirty: staged.length + unstaged.length + untracked.length > 0,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
  }
}

export interface NumstatEntry {
  path: string
  additions: number
  deletions: number
  renamedFrom?: string
}

/** `git diff --numstat` lines: `added\tdeleted\tpath` (binary = `-`). */
export function parseNumstat(text: string): NumstatEntry[] {
  const entries: NumstatEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    const [a, d, ...pathParts] = line.split('\t')
    if (a === undefined || d === undefined || pathParts.length === 0) continue
    let filePath = pathParts.join('\t')
    let renamedFrom: string | undefined
    // Rename forms: `old => new` or `dir/{old => new}/file`.
    const braced = filePath.match(/^(.*)\{(.*) => (.*)\}(.*)$/)
    if (braced) {
      renamedFrom = `${braced[1]}${braced[2]}${braced[4]}`
      filePath = `${braced[1]}${braced[3]}${braced[4]}`
    } else {
      const arrow = filePath.match(/^(.+) => (.+)$/)
      if (arrow) {
        renamedFrom = arrow[1] as string
        filePath = arrow[2] as string
      }
    }
    entries.push({
      path: filePath,
      additions: a === '-' ? 0 : Number(a),
      deletions: d === '-' ? 0 : Number(d),
      ...(renamedFrom !== undefined ? { renamedFrom } : {}),
    })
  }
  return entries
}

/**
 * Unified diff for ONE file → FileDiff with hunks. Serialized hunks past
 * 512 KiB (RELAY_LIMITS.maxDiffFileHunksBytes) are cut with `truncated: true`.
 */
export function parseFileDiff(text: string, filePath: string, forcedStatus?: FileDiff['status']): GitDiffFileResult {
  let status: FileDiff['status'] = forcedStatus ?? 'modified'
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let additions = 0
  let deletions = 0
  let truncated = false
  let hunkBytes = 0
  const cap = RELAY_LIMITS.maxDiffFileHunksBytes

  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) {
      const headerEnd = line.indexOf('@@', 2)
      const header = headerEnd >= 0 ? line.slice(0, headerEnd + 2) : line
      current = { header, lines: [] }
      hunkBytes += Buffer.byteLength(header)
      if (hunkBytes > cap) {
        truncated = true
        current = null
        continue
      }
      hunks.push(current)
      continue
    }
    if (line.startsWith('new file mode')) {
      if (!forcedStatus) status = 'added'
      continue
    }
    if (line.startsWith('deleted file mode')) {
      if (!forcedStatus) status = 'deleted'
      continue
    }
    if (line.startsWith('rename from')) {
      if (!forcedStatus) status = 'renamed'
      continue
    }
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('similarity index') || line.startsWith('rename to') || line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('Binary files')) {
      continue
    }
    if (current === null) {
      if (truncated && (line.startsWith('+') || line.startsWith('-'))) {
        // still count totals past the truncation point
        if (line.startsWith('+')) additions++
        else deletions++
      }
      continue
    }
    let kind: DiffLine['kind'] | null = null
    if (line.startsWith('+')) {
      kind = 'add'
      additions++
    } else if (line.startsWith('-')) {
      kind = 'del'
      deletions++
    } else if (line.startsWith(' ')) {
      kind = 'ctx'
    } else if (line.startsWith('\\') || line === '') {
      continue // "\ No newline at end of file" / trailing newline
    }
    if (kind === null) continue
    const textPart = line.length > 0 ? line.slice(1) : ''
    hunkBytes += Buffer.byteLength(textPart) + 8
    if (hunkBytes > cap) {
      truncated = true
      current = null
      continue
    }
    current.lines.push({ kind, text: textPart })
  }

  return {
    path: filePath,
    status,
    additions,
    deletions,
    hunks,
    ...(truncated ? { truncated: true } : {}),
  }
}

interface WorktreeEntry {
  path: string
  branch: string
  detached: boolean
}

/** `git worktree list --porcelain` parser. */
export function parseWorktreePorcelain(text: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: Partial<WorktreeEntry> | null = null
  const flush = () => {
    if (current?.path) {
      entries.push({ path: current.path, branch: current.branch ?? 'HEAD', detached: current.detached ?? false })
    }
    current = null
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      current = { path: line.slice('worktree '.length) }
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (line === 'detached' && current) {
      current.detached = true
      current.branch = 'HEAD'
    } else if (line.trim() === '') {
      flush()
    }
  }
  flush()
  return entries
}

/** github remote → https web URL for the pushed branch (07 §7.4 "Compare on GitHub"). */
export function githubWebUrl(remoteUrl: string, branch: string): string | undefined {
  let ownerRepo: string | undefined
  const ssh = remoteUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(\.git)?$/)
  const https = remoteUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(\.git)?$/)
  if (ssh) ownerRepo = ssh[1]
  else if (https) ownerRepo = https[1]
  if (!ownerRepo) return undefined
  return `https://github.com/${ownerRepo}/tree/${encodeURIComponent(branch)}`
}
