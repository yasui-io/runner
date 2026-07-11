import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigError, CONFIG_VERSION, loadConfig, relayUrlFromApiUrl, saveConfig, type RunnerConfig } from '../src/config/config.js'
import { configPath } from '../src/config/paths.js'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'yasui-runner-config-'))
  process.env.YASUI_RUNNER_HOME = home
})

afterEach(() => {
  delete process.env.YASUI_RUNNER_HOME
  fs.rmSync(home, { recursive: true, force: true })
})

const validConfig = (): RunnerConfig => ({
  version: CONFIG_VERSION,
  runnerId: 'run_test1',
  token: 'yr_AbCdEfGhIjKlMnOp',
  relayUrl: 'wss://api.yasui.io/relay/v1',
  apiUrl: 'https://api.yasui.io',
  name: 'atlas',
  kind: 'laptop',
  roots: [],
  trustedProjects: [],
  allowBypassPermissions: false,
  redactionEnabled: true,
  maxConcurrentSessions: 2,
  logLevel: 'info',
  update: { auto: true, channel: 'latest' },
})

describe('config 0600 enforcement (04 §5, 08 T7)', () => {
  it('saveConfig writes 0600 and loadConfig round-trips', () => {
    saveConfig(validConfig())
    const mode = fs.statSync(configPath()).mode & 0o777
    expect(mode).toBe(0o600)
    const loaded = loadConfig()
    expect(loaded.runnerId).toBe('run_test1')
    expect(loaded.token).toBe('yr_AbCdEfGhIjKlMnOp')
  })

  it('hard-fails on group/world-readable config', () => {
    saveConfig(validConfig())
    fs.chmodSync(configPath(), 0o644)
    expect(() => loadConfig()).toThrowError(ConfigError)
    try {
      loadConfig()
    } catch (err) {
      expect((err as ConfigError).kind).toBe('perms')
      expect((err as ConfigError).message).toContain('chmod 600')
    }
  })

  it('--insecure-perms escape hatch loads anyway', () => {
    saveConfig(validConfig())
    fs.chmodSync(configPath(), 0o644)
    expect(loadConfig({ insecurePerms: true }).runnerId).toBe('run_test1')
  })

  it('missing config raises kind=missing with the connect hint', () => {
    try {
      loadConfig()
      expect.unreachable()
    } catch (err) {
      expect((err as ConfigError).kind).toBe('missing')
      expect((err as ConfigError).message).toContain('yasui-runner connect')
    }
  })

  it('rejects malformed token shapes', () => {
    const bad = { ...validConfig(), token: 'not-a-token' }
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(configPath(), JSON.stringify(bad), { mode: 0o600 })
    try {
      loadConfig()
      expect.unreachable()
    } catch (err) {
      expect((err as ConfigError).kind).toBe('invalid')
    }
  })

  it('atomic write leaves no temp files behind', () => {
    saveConfig(validConfig())
    saveConfig({ ...validConfig(), name: 'atlas-2' })
    const files = fs.readdirSync(home)
    expect(files.filter((f) => f.includes('tmp'))).toHaveLength(0)
    expect(loadConfig().name).toBe('atlas-2')
  })
})

describe('relayUrlFromApiUrl', () => {
  it('https → wss with /relay/v1', () => {
    expect(relayUrlFromApiUrl('https://api.yasui.io')).toBe('wss://api.yasui.io/relay/v1')
  })
  it('http → ws (local dev)', () => {
    expect(relayUrlFromApiUrl('http://localhost:8787')).toBe('ws://localhost:8787/relay/v1')
  })
  it('strips trailing slashes', () => {
    expect(relayUrlFromApiUrl('https://api.yasui.io///')).toBe('wss://api.yasui.io/relay/v1')
  })
})
