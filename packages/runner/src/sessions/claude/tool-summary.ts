/**
 * Per-tool input/output summarization (05 §5.1 table + §5.2).
 *
 * `summary` is the collapsed one-liner shown in the transcript row; `input` the
 * expanded detail (≤4 KiB); `diff` only for edit-shaped tools. Paths render relative
 * to the session cwd.
 */

import type { DiffLine } from '@yasui.io/runner-protocol'
import { firstLine, truncate } from './support'

export const SUMMARY_MAX = 96
export const INPUT_DETAIL_MAX = 4096
export const DIFF_MAX_LINES = 400
export const OUTPUT_MAX = 4096
export const OUTPUT_HEAD = 3072
export const OUTPUT_TAIL = 1024
export const ERROR_TEXT_MAX = 1000

export interface ToolInputSummary {
  summary: string
  input?: string
  diff?: { path: string; lines: DiffLine[] }
}

/** Tools whose completion cannot have mutated the working tree (DiffWatcher gate, 04 §11). */
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'TaskGet',
  'TaskList',
  'TaskCreate',
  'TaskUpdate',
  'TodoWrite',
  'AskUserQuestion',
])

export function isMutatingTool(name: string): boolean {
  return !READ_ONLY_TOOLS.has(name)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function relPath(path: string, cwd: string): string {
  if (path === cwd) return '.'
  const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`
  if (path.startsWith(prefix)) return path.slice(prefix.length)
  return path
}

function jsonDetail(input: Record<string, unknown>): string {
  let json: string
  try {
    json = JSON.stringify(input, null, 2) ?? '{}'
  } catch {
    json = '[unserializable input]'
  }
  return truncate(json, INPUT_DETAIL_MAX)
}

function jsonOneLine(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input) ?? '{}'
  } catch {
    return '[unserializable input]'
  }
}

function toDiffLines(kind: 'add' | 'del', text: string): DiffLine[] {
  if (text === '') return []
  return text.split('\n').map((line) => ({ kind, text: line }))
}

function capDiffLines(lines: DiffLine[]): DiffLine[] {
  return lines.length > DIFF_MAX_LINES ? lines.slice(0, DIFF_MAX_LINES) : lines
}

/** §5.1 input summarization table. */
export function summarizeToolInput(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): ToolInputSummary {
  switch (name) {
    case 'Bash': {
      const command = str(input.command)
      const description = str(input.description)
      return {
        summary: truncate(`$ ${firstLine(command)}`, SUMMARY_MAX),
        input: truncate(description ? `${command}\n# ${description}` : command, INPUT_DETAIL_MAX),
      }
    }
    case 'Edit': {
      const path = relPath(str(input.file_path), cwd)
      // del/add lines from old_string → new_string; ctx lines intentionally omitted (§5.1).
      const lines = capDiffLines([
        ...toDiffLines('del', str(input.old_string)),
        ...toDiffLines('add', str(input.new_string)),
      ])
      return { summary: path, diff: { path, lines } }
    }
    case 'Write': {
      const path = relPath(str(input.file_path), cwd)
      const lines = capDiffLines(toDiffLines('add', str(input.content)))
      return { summary: `${path} (new file)`, diff: { path, lines } }
    }
    case 'NotebookEdit': {
      const path = relPath(str(input.notebook_path), cwd)
      const cellId = str(input.cell_id)
      const lines = capDiffLines(toDiffLines('add', str(input.new_source)))
      return {
        summary: cellId ? `${path} · cell ${cellId}` : path,
        diff: { path, lines },
      }
    }
    case 'Read': {
      const path = relPath(str(input.file_path), cwd)
      const offset = typeof input.offset === 'number' ? input.offset : null
      const limit = typeof input.limit === 'number' ? input.limit : null
      let range = ''
      if (offset !== null || limit !== null) {
        const start = offset ?? 0
        range = limit !== null ? `:${start}-${start + limit}` : `:${start}-`
      }
      return { summary: truncate(`${path}${range}`, SUMMARY_MAX) }
    }
    case 'Grep': {
      const pattern = str(input.pattern)
      const where = input.path ? relPath(str(input.path), cwd) : '.'
      return {
        summary: truncate(`"${pattern}" in ${where}`, SUMMARY_MAX),
        input: jsonDetail(input),
      }
    }
    case 'Glob':
      return { summary: truncate(str(input.pattern), SUMMARY_MAX) }
    case 'WebFetch': {
      let summary = str(input.url)
      try {
        const url = new URL(summary)
        summary = `${url.host}${url.pathname}`
      } catch {
        // keep the raw string
      }
      return {
        summary: truncate(summary, SUMMARY_MAX),
        input: truncate(str(input.prompt), INPUT_DETAIL_MAX) || undefined,
      }
    }
    case 'WebSearch': {
      const query = str(input.query)
      return { summary: truncate(query, SUMMARY_MAX), input: truncate(query, INPUT_DETAIL_MAX) }
    }
    default: {
      if (name.startsWith('mcp__')) {
        const rest = name.slice('mcp__'.length)
        const sep = rest.indexOf('__')
        if (sep > 0) {
          return {
            summary: truncate(`${rest.slice(0, sep)}: ${rest.slice(sep + 2)}`, SUMMARY_MAX),
            input: jsonDetail(input),
          }
        }
      }
      return {
        summary: truncate(`${name} ${jsonOneLine(input)}`, SUMMARY_MAX),
        input: jsonDetail(input),
      }
    }
  }
}

/** One-line human summary for the permission dock (`permission.request`, 05 §6). */
export function summarizeForPermission(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): string {
  return summarizeToolInput(name, input, cwd).summary
}

/** Coerce a hook `tool_response` (or user-message tool_result content) to text (§5.2). */
export function coerceToolResponse(response: unknown): string {
  if (response == null) return ''
  if (typeof response === 'string') return response
  if (Array.isArray(response)) {
    // content-block arrays → concatenated text parts
    return response
      .map((block) => {
        if (typeof block === 'string') return block
        if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
          return str((block as { text?: unknown }).text)
        }
        return ''
      })
      .filter((part) => part !== '')
      .join('\n')
  }
  if (typeof response === 'object') {
    // Common carrier shape: { content: <string | blocks>, ... }
    const content = (response as { content?: unknown }).content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return coerceToolResponse(content)
    try {
      return JSON.stringify(response, null, 2) ?? ''
    } catch {
      return '[unserializable tool output]'
    }
  }
  return String(response)
}

/**
 * §5.2 output summarization: cap 4 096 chars (first 3 072 + marker + last 1 024).
 * `Read` output is elided to `"<n> lines read"` — the UI never renders file dumps.
 */
export function summarizeToolOutput(name: string, response: unknown): string {
  const text = coerceToolResponse(response)
  if (name === 'Read') {
    const lines = text === '' ? 0 : text.split('\n').length
    return `${lines} lines read`
  }
  if (text.length <= OUTPUT_MAX) return text
  const cut = text.length - OUTPUT_HEAD - OUTPUT_TAIL
  return `${text.slice(0, OUTPUT_HEAD)}\n… [+${cut} chars truncated] …\n${text.slice(text.length - OUTPUT_TAIL)}`
}
