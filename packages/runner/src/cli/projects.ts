/**
 * `yasui-runner projects add <path> | list | remove <path> | trust <path>` (04 §6).
 *
 * add    — realpath, verify directory exists, append to roots, trigger an
 *          immediate rescan + project.list push when the daemon is running.
 * trust  — realpath, require a discovered project under a configured root,
 *          append to trustedProjects (flips settingSources for NEW sessions;
 *          08 T5b). Connected daemon pushes project.list with the flag.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Command } from 'commander'
import { loadConfig, saveConfig } from '../config/config.js'
import { controlSocketPath } from '../config/paths.js'
import { controlRequest, daemonReachable } from '../daemon/control.sock.js'
import { GitService } from '../git/git-service.js'
import { ProjectDiscovery } from '../projects/discovery.js'

async function nudgeDaemon(cmd: 'reload-config' | 'rescan'): Promise<void> {
  const sock = controlSocketPath()
  if (await daemonReachable(sock)) {
    try {
      await controlRequest(sock, { cmd }, 90_000)
    } catch (err) {
      process.stderr.write(`warning: daemon nudge failed: ${(err as Error).message}\n`)
    }
  }
}

export function registerProjects(program: Command): void {
  const projects = program.command('projects').description('manage project discovery roots and trust')

  projects
    .command('add <path>')
    .description('add a projects root (discovery allowlist)')
    .action(async (rawPath: string) => {
      const config = loadConfig()
      let real: string
      try {
        real = fs.realpathSync(rawPath)
        if (!fs.statSync(real).isDirectory()) throw new Error('not a directory')
      } catch {
        process.stderr.write(`${rawPath} is not an existing directory\n`)
        process.exitCode = 1
        return
      }
      if (config.roots.includes(real)) {
        process.stdout.write(`${real} is already a projects root\n`)
        return
      }
      config.roots.push(real)
      saveConfig(config)
      process.stdout.write(`added projects root ${real}\n`)
      await nudgeDaemon('reload-config')
    })

  projects
    .command('list')
    .description('list discovered projects')
    .option('--json', 'machine-readable output', false)
    .action(async (opts: { json: boolean }) => {
      const config = loadConfig()
      const git = new GitService({ roots: () => config.roots })
      const discovery = new ProjectDiscovery({
        roots: () => config.roots,
        trustedProjects: () => config.trustedProjects,
        git,
      })
      const cached = discovery.current()
      const list = cached.length > 0 ? cached : await discovery.scan()
      if (opts.json) {
        process.stdout.write(JSON.stringify(list, null, 2) + '\n')
        return
      }
      if (list.length === 0) {
        process.stdout.write(`no projects found under: ${config.roots.join(', ') || '(no roots configured)'}\n`)
        return
      }
      for (const project of list) {
        process.stdout.write(
          `${project.trusted ? '✓ trusted  ' : '           '}${project.path}  [${project.branch}${project.dirty ? ' *' : ''}]\n`,
        )
      }
    })

  projects
    .command('remove <path>')
    .description('remove a projects root')
    .action(async (rawPath: string) => {
      const config = loadConfig()
      let real = rawPath
      try {
        real = fs.realpathSync(rawPath)
      } catch {
        /* removing a now-deleted root by its recorded path is fine */
      }
      const before = config.roots.length
      config.roots = config.roots.filter((r) => r !== real && r !== rawPath)
      config.trustedProjects = config.trustedProjects.filter(
        (p) => config.roots.some((r) => p === r || p.startsWith(r + path.sep)),
      )
      if (config.roots.length === before) {
        process.stderr.write(`${rawPath} is not a configured root\n`)
        process.exitCode = 1
        return
      }
      saveConfig(config)
      process.stdout.write(`removed projects root ${real}\n`)
      await nudgeDaemon('reload-config')
    })

  projects
    .command('trust <path>')
    .description('trust a project: allows its .claude/ settings + .mcp.json to load in sessions')
    .action(async (rawPath: string) => {
      const config = loadConfig()
      let real: string
      try {
        real = fs.realpathSync(rawPath)
      } catch {
        process.stderr.write(`${rawPath} does not exist\n`)
        process.exitCode = 1
        return
      }
      const underRoot = config.roots.some((r) => {
        try {
          const realRoot = fs.realpathSync(r)
          return real === realRoot || real.startsWith(realRoot + path.sep)
        } catch {
          return false
        }
      })
      if (!underRoot) {
        process.stderr.write(`${real} is not under a configured projects root (add one with \`yasui-runner projects add\`)\n`)
        process.exitCode = 1
        return
      }
      if (!fs.existsSync(path.join(real, '.git'))) {
        process.stderr.write(`${real} is not a git project (no .git)\n`)
        process.exitCode = 1
        return
      }
      if (config.trustedProjects.includes(real)) {
        process.stdout.write(`${real} is already trusted\n`)
        return
      }
      config.trustedProjects.push(real)
      saveConfig(config)
      process.stdout.write(
        `trusted ${real}\nsessions started from now on load its .claude/ settings, commands, skills and .mcp.json\n`,
      )
      await nudgeDaemon('reload-config')
    })
}
