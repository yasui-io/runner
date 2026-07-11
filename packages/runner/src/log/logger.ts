/**
 * Local-only pino logging with hand-rolled 10 MiB × 5 rotation (04 §13).
 *
 * No pino transports (keeps the dependency tree minimal and works identically
 * under Node and Bun): a synchronous rotating file destination implementing
 * pino's DestinationStream contract. Credentials are never logged — pino
 * redact paths cover `authorization` headers and any field named
 * token/key/authToken (08 §2 invariants).
 */

import fs from 'node:fs'
import path from 'node:path'
import { destination, pino, type Logger } from 'pino'

export const LOG_MAX_BYTES = 10 * 1024 * 1024
export const LOG_MAX_FILES = 5

const REDACT_PATHS = [
  'token',
  '*.token',
  'key',
  '*.key',
  'authToken',
  '*.authToken',
  'authorization',
  '*.authorization',
  'headers.authorization',
]

/** pino DestinationStream with size-based rotation: file → file.1 → … → file.5. */
export class RotatingFileDestination {
  private fd: number | null = null
  private bytes = 0
  private failed = false

  constructor(
    private readonly file: string,
    private readonly maxBytes = LOG_MAX_BYTES,
    private readonly maxFiles = LOG_MAX_FILES,
  ) {}

  private open(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    this.fd = fs.openSync(this.file, 'a', 0o600)
    this.bytes = fs.fstatSync(this.fd).size
  }

  private rotate(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd)
      this.fd = null
    }
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = `${this.file}.${i}`
      const to = `${this.file}.${i + 1}`
      try {
        fs.renameSync(from, to)
      } catch {
        /* gap in the chain is fine */
      }
    }
    try {
      fs.renameSync(this.file, `${this.file}.1`)
    } catch {
      /* nothing to rotate */
    }
  }

  write(msg: string): void {
    try {
      if (this.fd === null) this.open()
      if (this.bytes + Buffer.byteLength(msg) > this.maxBytes) {
        this.rotate()
        this.open()
      }
      fs.writeSync(this.fd as number, msg)
      this.bytes += Buffer.byteLength(msg)
      this.failed = false
    } catch {
      // Disk full / unwritable log dir: drop to console-only (04 §14) — never
      // crash the daemon over logging.
      if (!this.failed) {
        this.failed = true
        try {
          process.stderr.write(`yasui-runner: log write failed for ${this.file}; logging to stderr only\n`)
        } catch {
          /* ignore */
        }
      }
      try {
        process.stderr.write(msg)
      } catch {
        /* ignore */
      }
    }
  }

  close(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd)
      } catch {
        /* ignore */
      }
      this.fd = null
    }
  }
}

export interface LoggerOptions {
  level?: string
  /** Log file path; omit for stderr (foreground / CLI usage). */
  file?: string
  name?: string
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const base = {
    name: opts.name ?? 'yasui-runner',
    level: opts.level ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  }
  if (opts.file) {
    return pino(base, new RotatingFileDestination(opts.file))
  }
  return pino({ ...base }, destination(2))
}

export type { Logger }
