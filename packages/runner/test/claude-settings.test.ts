import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RELAY_LIMITS } from '@yasui.io/runner-protocol'
import {
  ClaudeSettingsError,
  MAX_CLAUDE_SETTINGS_BYTES,
  readClaudeSettings,
  updateClaudeSettings,
} from '../src/settings/claude-settings.js'

let home: string
const settingsPath = () => join(home, '.claude', 'settings.json')

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yasui-claude-settings-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('native Claude settings', () => {
  it('returns an empty document when the file does not exist', async () => {
    const result = await readClaudeSettings('op_1', 'native-user', home)
    expect(result).toMatchObject({ settings: {}, revision: null, exists: false, redactedPaths: [] })
  })

  it('patches nested values, preserves unknown keys and untouched secrets, and writes mode 0600', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify({ futureSetting: { enabled: true }, env: { TOKEN: 'secret' } }))
    const initial = await readClaudeSettings('op_1', 'native-user', home)
    expect(initial.settings).toEqual({ futureSetting: { enabled: true }, env: { TOKEN: null } })
    expect(initial.redactedPaths).toEqual([['env', 'TOKEN']])

    const saved = await updateClaudeSettings(
      'op_2',
      'native-user',
      [{ op: 'set', path: ['permissions', 'defaultMode'], value: 'plan' }],
      initial.revision,
      false,
      home,
    )
    const onDisk = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    expect(onDisk).toEqual({
      futureSetting: { enabled: true },
      env: { TOKEN: 'secret' },
      permissions: { defaultMode: 'plan' },
    })
    expect(saved.settings.env).toEqual({ TOKEN: null })
    expect(lstatSync(settingsPath()).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(home, '.claude')).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('supports nested delete operations', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsPath(), '{"permissions":{"allow":["Read(*)"],"deny":["Bash(*)"]}}')
    const initial = await readClaudeSettings('op_1', 'native-user', home)
    await updateClaudeSettings(
      'op_2',
      'native-user',
      [{ op: 'delete', path: ['permissions', 'allow'] }],
      initial.revision,
      false,
      home,
    )
    expect(JSON.parse(readFileSync(settingsPath(), 'utf8'))).toEqual({ permissions: { deny: ['Bash(*)'] } })
  })

  it('rejects stale revisions', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsPath(), '{}')
    const initial = await readClaudeSettings('op_1', 'native-user', home)
    writeFileSync(settingsPath(), '{"model":"changed-locally"}')
    await expect(
      updateClaudeSettings('op_2', 'native-user', [{ op: 'set', path: ['model'], value: 'remote' }], initial.revision, false, home),
    ).rejects.toMatchObject({ code: 'yasui_claude_settings_conflict' })
  })

  it('backs up malformed JSON only after explicit reset confirmation', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsPath(), '{broken', { mode: 0o644 })
    const initial = await readClaudeSettings('op_1', 'native-user', home)
    expect(initial.parseError).toBeTruthy()
    await expect(
      updateClaudeSettings('op_2', 'native-user', [{ op: 'set', path: ['model'], value: 'claude' }], initial.revision, false, home),
    ).rejects.toMatchObject({ code: 'yasui_claude_settings_malformed' })

    await updateClaudeSettings(
      'op_3',
      'native-user',
      [{ op: 'set', path: ['model'], value: 'claude' }],
      initial.revision,
      true,
      home,
    )
    const backup = readdirSync(join(home, '.claude')).find((name) => name.startsWith('settings.json.yasui-backup-'))
    expect(backup).toBeTruthy()
    expect(readFileSync(join(home, '.claude', backup!), 'utf8')).toBe('{broken')
    expect(lstatSync(join(home, '.claude', backup!)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(settingsPath(), 'utf8'))).toEqual({ model: 'claude' })
  })

  it('rejects top-level arrays, symlinks, oversized files, and unsafe object keys', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsPath(), '[]')
    const arrayDocument = await readClaudeSettings('op_1', 'native-user', home)
    expect(arrayDocument.parseError).toContain('top-level')

    rmSync(settingsPath())
    writeFileSync(join(home, 'target.json'), '{}')
    symlinkSync(join(home, 'target.json'), settingsPath())
    await expect(readClaudeSettings('op_2', 'native-user', home)).rejects.toMatchObject({ code: 'yasui_claude_settings_unsafe_file' })

    rmSync(settingsPath())
    writeFileSync(settingsPath(), 'x'.repeat(MAX_CLAUDE_SETTINGS_BYTES + 1))
    await expect(readClaudeSettings('op_3', 'native-user', home)).rejects.toMatchObject({ code: 'yasui_claude_settings_too_large' })

    rmSync(settingsPath())
    writeFileSync(settingsPath(), '{}')
    const clean = await readClaudeSettings('op_4', 'native-user', home)
    await expect(
      updateClaudeSettings('op_5', 'native-user', [{ op: 'set', path: ['__proto__', 'polluted'], value: true }], clean.revision, false, home),
    ).rejects.toBeInstanceOf(ClaudeSettingsError)
    const unsafeValue = JSON.parse('{"__proto__":"bad"}')
    await expect(
      updateClaudeSettings('op_6', 'native-user', [{ op: 'set', path: ['custom'], value: unsafeValue }], clean.revision, false, home),
    ).rejects.toMatchObject({ code: 'yasui_claude_settings_invalid' })
  })

  it('keeps the largest accepted redacted response below the relay frame limit', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    const env: Record<string, string> = {}
    for (let index = 0; index < 8_000; index += 1) env[`SECRET_${index}`] = 'value'
    let serialized = JSON.stringify({ env })
    expect(Buffer.byteLength(serialized)).toBeLessThan(MAX_CLAUDE_SETTINGS_BYTES)
    writeFileSync(settingsPath(), serialized)
    const result = await readClaudeSettings('op_max', 'native-user', home)
    const frame = JSON.stringify({
      id: 'f_settings_max',
      type: 'claude.settings.result',
      ts: new Date().toISOString(),
      payload: result,
    })
    expect(Buffer.byteLength(frame)).toBeLessThan(RELAY_LIMITS.maxFrameBytes)
  })
})
