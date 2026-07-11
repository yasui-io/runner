import { createHash, randomBytes } from 'node:crypto'
import { mkdir, lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type {
  ClaudeSettingsObject,
  ClaudeSettingsPatchOperation,
  ClaudeSettingsResultPayload,
  ClaudeSettingsTarget,
} from '@yasui.io/runner-protocol'

export const MAX_CLAUDE_SETTINGS_BYTES = 256 * 1024

const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
const SECRET_KEY = /(?:^|[_-])(api[-_]?key|token|secret|password|authorization|cookie|credential)s?$/i

export class ClaudeSettingsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly revision?: string | null,
  ) {
    super(message)
    this.name = 'ClaudeSettingsError'
  }
}

function settingsPath(target: ClaudeSettingsTarget, homeDir = homedir()): string {
  if (target !== 'native-user') {
    throw new ClaudeSettingsError('yasui_claude_settings_target_invalid', 'Unsupported Claude settings target.')
  }
  return join(homeDir, '.claude', 'settings.json')
}

function revisionOf(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function isPlainObject(value: unknown): value is ClaudeSettingsObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertJsonValue(value: unknown, path: string[] = []): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ClaudeSettingsError('yasui_claude_settings_invalid', `Non-finite number at ${path.join('.') || '<root>'}.`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, [...path, String(index)]))
    return
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_PATH_SEGMENTS.has(key)) {
        throw new ClaudeSettingsError('yasui_claude_settings_invalid', `Unsafe object key at ${[...path, key].join('.')}.`)
      }
      assertJsonValue(entry, [...path, key])
    }
    return
  }
  throw new ClaudeSettingsError('yasui_claude_settings_invalid', `Unsupported value at ${path.join('.') || '<root>'}.`)
}

function shouldRedact(path: string[]): boolean {
  const key = path.at(-1) ?? ''
  if (path[0] === 'env' && path.length > 1) return true
  if (path.includes('env') && path[0] === 'mcpServers') return true
  if (path.includes('headers') && /authorization|cookie|token|key|secret/i.test(key)) return true
  return SECRET_KEY.test(key)
}

function redactValue(value: unknown, path: string[], redactedPaths: string[][]): unknown {
  if (shouldRedact(path)) {
    redactedPaths.push(path)
    return null
  }
  if (Array.isArray(value)) return value.map((entry, index) => redactValue(entry, [...path, String(index)], redactedPaths))
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactValue(entry, [...path, key], redactedPaths)]),
    )
  }
  return value
}

async function readRaw(path: string): Promise<{ data: Buffer | null; modifiedAt: string | null }> {
  try {
    const file = await lstat(path)
    if (file.isSymbolicLink() || !file.isFile()) {
      throw new ClaudeSettingsError(
        'yasui_claude_settings_unsafe_file',
        '~/.claude/settings.json must be a regular file, not a symlink or special file.',
      )
    }
    if (file.size > MAX_CLAUDE_SETTINGS_BYTES) {
      throw new ClaudeSettingsError(
        'yasui_claude_settings_too_large',
        `Claude settings exceed the ${MAX_CLAUDE_SETTINGS_BYTES / 1024} KiB editor limit.`,
      )
    }
    return { data: await readFile(path), modifiedAt: file.mtime.toISOString() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { data: null, modifiedAt: null }
    throw error
  }
}

export async function readClaudeSettings(
  opId: string,
  target: ClaudeSettingsTarget,
  homeDir = homedir(),
): Promise<Extract<ClaudeSettingsResultPayload, { ok: true }>> {
  const path = settingsPath(target, homeDir)
  const raw = await readRaw(path)
  const revision = raw.data ? revisionOf(raw.data) : null
  let settings: ClaudeSettingsObject = {}
  let parseError: string | undefined

  if (raw.data) {
    try {
      const parsed: unknown = JSON.parse(raw.data.toString('utf8'))
      if (!isPlainObject(parsed)) throw new Error('The top-level value must be an object.')
      settings = parsed
    } catch (error) {
      parseError = error instanceof Error ? error.message : 'Invalid JSON.'
    }
  }

  const redactedPaths: string[][] = []
  const redacted = redactValue(settings, [], redactedPaths) as ClaudeSettingsObject
  return {
    opId,
    action: 'get',
    target,
    ok: true,
    settings: redacted,
    revision,
    exists: raw.data !== null,
    modifiedAt: raw.modifiedAt,
    redactedPaths,
    ...(parseError ? { parseError } : {}),
  }
}

function applyPatch(settings: ClaudeSettingsObject, patch: ClaudeSettingsPatchOperation[]): ClaudeSettingsObject {
  const next = structuredClone(settings)
  for (const operation of patch) {
    if (operation.path.length === 0 || operation.path.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment))) {
      throw new ClaudeSettingsError('yasui_claude_settings_invalid', 'The settings patch contains an unsafe path.')
    }
    let parent: ClaudeSettingsObject | unknown[] = next
    for (const segment of operation.path.slice(0, -1)) {
      if (Array.isArray(parent)) {
        const index = Number(segment)
        if (!Number.isInteger(index) || index < 0 || index > parent.length) {
          throw new ClaudeSettingsError('yasui_claude_settings_invalid', `Invalid array index at ${segment}.`)
        }
        const current = parent[index]
        if (!isPlainObject(current) && !Array.isArray(current)) parent[index] = {}
        parent = parent[index] as ClaudeSettingsObject | unknown[]
      } else {
        const current = parent[segment]
        if (!isPlainObject(current) && !Array.isArray(current)) parent[segment] = {}
        parent = parent[segment] as ClaudeSettingsObject | unknown[]
      }
    }
    const key = operation.path.at(-1)!
    if (Array.isArray(parent)) {
      const index = Number(key)
      if (!Number.isInteger(index) || index < 0 || index > parent.length) {
        throw new ClaudeSettingsError('yasui_claude_settings_invalid', `Invalid array index at ${key}.`)
      }
      if (operation.op === 'delete') {
        if (index < parent.length) parent.splice(index, 1)
      } else if (index === parent.length) parent.push(operation.value)
      else parent[index] = operation.value
    } else if (operation.op === 'delete') delete parent[key]
    else parent[key] = operation.value
  }
  assertJsonValue(next)
  return next
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const tempPath = join(directory, `.settings.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(tempPath, 'wx', 0o600)
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await rename(tempPath, path)
    let directoryHandle: Awaited<ReturnType<typeof open>> | null = null
    try {
      directoryHandle = await open(directory, 'r')
      await directoryHandle.sync()
    } catch {
      // Some filesystems do not allow directory fsync; the file itself is durable.
    } finally {
      await directoryHandle?.close().catch(() => undefined)
    }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
}

async function writeBackup(path: string, data: Uint8Array): Promise<void> {
  const backupPath = `${path}.yasui-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(backupPath, 'wx', 0o600)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = null
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(backupPath).catch(() => undefined)
    throw error
  }
}

export async function updateClaudeSettings(
  opId: string,
  target: ClaudeSettingsTarget,
  patch: ClaudeSettingsPatchOperation[],
  expectedRevision: string | null,
  allowMalformedReset = false,
  homeDir = homedir(),
): Promise<Extract<ClaudeSettingsResultPayload, { ok: true }>> {
  const path = settingsPath(target, homeDir)
  const raw = await readRaw(path)
  const currentRevision = raw.data ? revisionOf(raw.data) : null
  if (currentRevision !== expectedRevision) {
    throw new ClaudeSettingsError(
      'yasui_claude_settings_conflict',
      'Claude settings changed on the runner. Reload before saving again.',
      currentRevision,
    )
  }

  let current: unknown = {}
  let malformed = false
  if (raw.data) {
    try {
      current = JSON.parse(raw.data.toString('utf8'))
    } catch {
      malformed = true
    }
  }
  if (!isPlainObject(current)) malformed = raw.data !== null
  if (malformed && !allowMalformedReset) {
    throw new ClaudeSettingsError(
      'yasui_claude_settings_malformed',
      'Claude settings contain invalid JSON. Confirm backup and reset before saving.',
      currentRevision,
    )
  }
  if (malformed) {
    await writeBackup(path, raw.data!)
    current = {}
  }

  const next = applyPatch(current as ClaudeSettingsObject, patch)
  const contents = `${JSON.stringify(next, null, 2)}\n`
  if (Buffer.byteLength(contents, 'utf8') > MAX_CLAUDE_SETTINGS_BYTES) {
    throw new ClaudeSettingsError(
      'yasui_claude_settings_too_large',
      `Claude settings exceed the ${MAX_CLAUDE_SETTINGS_BYTES / 1024} KiB editor limit.`,
    )
  }
  await atomicWrite(path, contents)

  const saved = await readClaudeSettings(opId, target, homeDir)
  return { ...saved, action: 'update' }
}
