/**
 * Shared internals for the Claude adapter: event ids, timestamps, logging shim.
 *
 * Event ids are `ev_<cuid2>` (05 §1). No cuid2 package exists anywhere in the runner
 * dependency tree (zod / pino / ws / commander / @yasui.io/runner-protocol carry none), so
 * this is a hand-rolled cuid2-shaped generator: 24 chars, lowercase-letter first char,
 * base36 body mixing wall clock + a per-process counter + CSPRNG bytes. It matches
 * cuid2's shape and collision posture for our purposes (ids are namespaced per session
 * and only need uniqueness within one runner process + control-plane ledger).
 */

import { randomBytes } from 'node:crypto'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

let counter = Math.floor(Math.random() * 36 ** 4)

/** cuid2-shaped 24-char id: [a-z][a-z0-9]{23}. */
export function createId(): string {
  counter = (counter + 1) % 36 ** 4
  const time = Date.now().toString(36)
  const count = counter.toString(36).padStart(4, '0')
  const bytes = randomBytes(16)
  let random = ''
  for (let i = 0; i < bytes.length; i++) random += ALPHABET[(bytes[i] as number) % 36]
  const body = (time + count + random).slice(0, 23)
  return LETTERS[(bytes[15] as number) % 26] + body
}

export function newEventId(): string {
  return `ev_${createId()}`
}

/** ISO-8601 with milliseconds (02 §5 `ts` / event `at` format). */
export function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Minimal structural logger — pino's `Logger` satisfies this (obj-first call form).
 * The adapter never constructs its own pino instance; the runner core passes a child
 * logger. Defaults to a no-op so unit tests stay silent.
 */
export interface AdapterLogger {
  debug(obj: unknown, msg?: string): void
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export const noopLogger: AdapterLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

/** Error with a yasui_snake_case code (the runner repo has no ApiError; 04 §14). */
export class AdapterError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AdapterError'
  }
}

/** First line of a string, trimmed. */
export function firstLine(text: string): string {
  const idx = text.indexOf('\n')
  return (idx === -1 ? text : text.slice(0, idx)).trim()
}

/** Truncate to `max` chars, ellipsis-terminated when cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}
