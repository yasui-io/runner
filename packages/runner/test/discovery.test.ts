import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findGitDirs, ProjectDiscovery } from '../src/projects/discovery.js'
import { GitService } from '../src/git/git-service.js'

let root: string

function makeRepo(rel: string): string {
  const repo = path.join(root, rel)
  fs.mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo })
  fs.writeFileSync(path.join(repo, 'README.md'), rel)
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
  return fs.realpathSync(repo)
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yasui-discovery-'))
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('findGitDirs (04 §8.4)', () => {
  it('BFS depth 4, skip list, .git dirs are projects and not descended', () => {
    const top = makeRepo('proj-top') // depth 1
    const nested = makeRepo('group/sub/proj-deep') // depth 3
    makeRepo('a/b/c/d/proj-too-deep') // depth 5 — beyond max
    const insideRepo = path.join(top, 'nested-inside-repo')
    fs.mkdirSync(insideRepo, { recursive: true })
    fs.mkdirSync(path.join(insideRepo, '.git')) // inside a project — must not be found
    const skipped = path.join(root, 'node_modules', 'sneaky')
    fs.mkdirSync(skipped, { recursive: true })
    fs.mkdirSync(path.join(skipped, '.git'))
    const vendored = path.join(root, 'vendor', 'lib')
    fs.mkdirSync(vendored, { recursive: true })
    fs.mkdirSync(path.join(vendored, '.git'))

    const found = findGitDirs([root])
    expect(found).toContain(top)
    expect(found).toContain(nested)
    expect(found.some((p) => p.includes('proj-too-deep'))).toBe(false)
    expect(found.some((p) => p.includes('nested-inside-repo'))).toBe(false)
    expect(found.some((p) => p.includes('node_modules'))).toBe(false)
    expect(found.some((p) => p.includes('vendor'))).toBe(false)
  })

  it('follows no symlinks', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'yasui-disc-outside-'))
    fs.mkdirSync(path.join(target, '.git'))
    const link = path.join(root, 'linked')
    fs.symlinkSync(target, link)
    try {
      const found = findGitDirs([root])
      expect(found.some((p) => p.includes('linked'))).toBe(false)
    } finally {
      fs.unlinkSync(link)
      fs.rmSync(target, { recursive: true, force: true })
    }
  })

  it('missing roots are skipped silently', () => {
    expect(findGitDirs([path.join(root, 'does-not-exist')])).toEqual([])
  })
})

describe('ProjectDiscovery metadata + cache', () => {
  it('scan() gathers branch/dirty/remote/lastCommitAt/trusted and caches to disk', async () => {
    const repo = makeRepo('meta-proj')
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/meta.git'], { cwd: repo })
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x') // make it dirty

    const cachePath = path.join(root, 'projects-cache.json')
    const git = new GitService({ roots: () => [root] })
    const discovery = new ProjectDiscovery({
      roots: () => [root],
      trustedProjects: () => [repo],
      git,
      cachePath: () => cachePath,
    })
    const projects = await discovery.scan()
    const meta = projects.find((p) => p.path === repo)
    expect(meta).toBeDefined()
    expect(meta?.name).toBe('meta-proj')
    expect(meta?.branch).toBe('main')
    expect(meta?.dirty).toBe(true)
    expect(meta?.remoteUrl).toBe('git@github.com:acme/meta.git')
    expect(meta?.trusted).toBe(true)
    expect(meta?.lastCommitAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // cache round-trip
    expect(fs.existsSync(cachePath)).toBe(true)
    const fresh = new ProjectDiscovery({
      roots: () => [root],
      trustedProjects: () => [],
      git,
      cachePath: () => cachePath,
    })
    expect(fresh.current().some((p) => p.path === repo)).toBe(true)
  })
})
