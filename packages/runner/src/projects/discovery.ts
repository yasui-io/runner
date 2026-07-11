/**
 * Project discovery — .git scan of allowlisted roots (04 §8.4).
 *
 * Scan each configured root: breadth-first, max depth 4, follow no symlinks,
 * skip `node_modules|Library|.cache|.Trash|vendor|target|dist`; a directory
 * containing `.git` is a project (and is not descended into). Metadata per
 * project: name (basename), branch, dirty, remoteUrl, lastCommitAt, trusted.
 * Results cached in `state/projects.json`; a full rescan also runs every
 * 15 min while connected (daemon owns the timer).
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Project } from '@yasui.io/runner-protocol'
import type { GitService } from '../git/git-service.js'
import { projectsCachePath } from '../config/paths.js'

export const DISCOVERY_MAX_DEPTH = 4
export const DISCOVERY_RESCAN_MS = 15 * 60 * 1000

const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'Library',
  '.cache',
  '.Trash',
  'vendor',
  'target',
  'dist',
])

export interface ProjectsCache {
  scannedAt: string
  projects: Project[]
}

export interface DiscoveryOptions {
  roots: () => string[]
  trustedProjects: () => string[]
  git: GitService
  cachePath?: () => string
  maxDepth?: number
}

/** Pure directory walk — exported for tests. Returns project directory paths. */
export function findGitDirs(roots: string[], maxDepth = DISCOVERY_MAX_DEPTH): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    let realRoot: string
    try {
      realRoot = fs.realpathSync(root)
    } catch {
      continue
    }
    // BFS from the root, depth 0 = the root itself.
    const queue: Array<{ dir: string; depth: number }> = [{ dir: realRoot, depth: 0 }]
    while (queue.length > 0) {
      const { dir, depth } = queue.shift() as { dir: string; depth: number }
      if (seen.has(dir)) continue
      seen.add(dir)
      let hasGit = false
      try {
        hasGit = fs.existsSync(path.join(dir, '.git'))
      } catch {
        continue
      }
      if (hasGit) {
        found.push(dir)
        continue // projects are not descended into
      }
      if (depth >= maxDepth) continue
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue // isDirectory() is false for symlinks — never followed
        if (SKIP_DIRS.has(entry.name)) continue
        if (entry.name === '.git') continue
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
      }
    }
  }
  return found.sort()
}

export class ProjectDiscovery {
  private cache: ProjectsCache | null = null
  private readonly cachePathFn: () => string
  private readonly maxDepth: number

  constructor(private readonly opts: DiscoveryOptions) {
    this.cachePathFn = opts.cachePath ?? projectsCachePath
    this.maxDepth = opts.maxDepth ?? DISCOVERY_MAX_DEPTH
  }

  /** Last scan results (loads the state/projects.json cache on first call). */
  current(): Project[] {
    if (this.cache) return this.cache.projects
    try {
      const raw = fs.readFileSync(this.cachePathFn(), 'utf8')
      const parsed = JSON.parse(raw) as ProjectsCache
      if (Array.isArray(parsed.projects)) {
        this.cache = parsed
        return parsed.projects
      }
    } catch {
      /* no cache yet */
    }
    return []
  }

  /** Full rescan of all roots; updates the cache file. */
  async scan(): Promise<Project[]> {
    const roots = this.opts.roots()
    const trusted = new Set(this.opts.trustedProjects())
    const dirs = findGitDirs(roots, this.maxDepth)
    const projects: Project[] = []
    for (const dir of dirs) {
      projects.push(await this.describe(dir, trusted.has(dir)))
    }
    this.cache = { scannedAt: new Date().toISOString(), projects }
    try {
      fs.mkdirSync(path.dirname(this.cachePathFn()), { recursive: true, mode: 0o700 })
      fs.writeFileSync(this.cachePathFn(), JSON.stringify(this.cache, null, 2) + '\n')
    } catch {
      /* cache write failure is non-fatal */
    }
    return projects
  }

  private async describe(dir: string, trusted: boolean): Promise<Project> {
    const { git } = this.opts
    let branch = ''
    let dirty = false
    let remoteUrl: string | null = null
    let lastCommitAt: string | null = null
    try {
      branch = await git.currentBranch(dir)
    } catch {
      branch = ''
    }
    try {
      dirty = await git.isDirty(dir)
    } catch {
      dirty = false
    }
    try {
      remoteUrl = await git.remoteUrl(dir)
    } catch {
      remoteUrl = null
    }
    try {
      lastCommitAt = await git.lastCommitAt(dir)
    } catch {
      lastCommitAt = null
    }
    return {
      path: dir,
      name: path.basename(dir),
      branch,
      dirty,
      remoteUrl,
      trusted,
      lastCommitAt,
    }
  }
}
