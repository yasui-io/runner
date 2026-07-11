/**
 * tool-summary tests: the §5.1 per-tool table + §5.2 output caps.
 */

import { describe, expect, it } from 'vitest'
import {
  coerceToolResponse,
  isMutatingTool,
  summarizeToolInput,
  summarizeToolOutput,
} from '../src/sessions/claude/tool-summary'

const CWD = '/home/dev/proj'

describe('summarizeToolInput', () => {
  it('Bash: "$ " + first line ≤96 chars; full command (+ description) as input', () => {
    const s = summarizeToolInput('Bash', { command: 'ls -la\necho hi', description: 'list files' }, CWD)
    expect(s.summary).toBe('$ ls -la')
    expect(s.input).toBe('ls -la\necho hi\n# list files')
    expect(s.diff).toBeUndefined()

    const long = summarizeToolInput('Bash', { command: 'x'.repeat(200) }, CWD)
    expect(long.summary.length).toBe(96)
  })

  it('Edit: relative path + del/add DiffLines, ctx omitted, ≤400 lines', () => {
    const s = summarizeToolInput(
      'Edit',
      { file_path: `${CWD}/src/a.ts`, old_string: 'old1\nold2', new_string: 'new1' },
      CWD,
    )
    expect(s.summary).toBe('src/a.ts')
    expect(s.diff).toEqual({
      path: 'src/a.ts',
      lines: [
        { kind: 'del', text: 'old1' },
        { kind: 'del', text: 'old2' },
        { kind: 'add', text: 'new1' },
      ],
    })

    const big = summarizeToolInput(
      'Edit',
      { file_path: `${CWD}/big.ts`, old_string: Array(300).fill('o').join('\n'), new_string: Array(300).fill('n').join('\n') },
      CWD,
    )
    expect(big.diff!.lines.length).toBe(400)
  })

  it('Write: "(new file)" + all-add lines', () => {
    const s = summarizeToolInput('Write', { file_path: `${CWD}/new.ts`, content: 'a\nb' }, CWD)
    expect(s.summary).toBe('new.ts (new file)')
    expect(s.diff!.lines).toEqual([
      { kind: 'add', text: 'a' },
      { kind: 'add', text: 'b' },
    ])
  })

  it('NotebookEdit: path · cell id, new_source as add lines', () => {
    const s = summarizeToolInput(
      'NotebookEdit',
      { notebook_path: `${CWD}/nb.ipynb`, cell_id: 'c12', new_source: 'print(1)' },
      CWD,
    )
    expect(s.summary).toBe('nb.ipynb · cell c12')
    expect(s.diff!.lines).toEqual([{ kind: 'add', text: 'print(1)' }])
  })

  it('Read: relative path with :offset-limit when set, no input detail', () => {
    expect(summarizeToolInput('Read', { file_path: `${CWD}/a.ts` }, CWD).summary).toBe('a.ts')
    const ranged = summarizeToolInput('Read', { file_path: `${CWD}/a.ts`, offset: 10, limit: 20 }, CWD)
    expect(ranged.summary).toBe('a.ts:10-30')
    expect(ranged.input).toBeUndefined()
  })

  it('Grep: "<pattern>" in <path ?? cwd> with full args JSON', () => {
    const s = summarizeToolInput('Grep', { pattern: 'TODO', path: `${CWD}/src` }, CWD)
    expect(s.summary).toBe('"TODO" in src')
    expect(s.input).toContain('"pattern": "TODO"')
    expect(summarizeToolInput('Grep', { pattern: 'x' }, CWD).summary).toBe('"x" in .')
  })

  it('Glob: pattern only', () => {
    const s = summarizeToolInput('Glob', { pattern: '**/*.ts' }, CWD)
    expect(s.summary).toBe('**/*.ts')
    expect(s.input).toBeUndefined()
  })

  it('WebFetch: host+path; WebSearch: query', () => {
    const f = summarizeToolInput('WebFetch', { url: 'https://example.com/docs/page?q=1', prompt: 'summarize' }, CWD)
    expect(f.summary).toBe('example.com/docs/page')
    expect(f.input).toBe('summarize')
    const w = summarizeToolInput('WebSearch', { query: 'bun workspaces' }, CWD)
    expect(w.summary).toBe('bun workspaces')
  })

  it('mcp__<srv>__<tool>: "<srv>: <tool>" + input JSON', () => {
    const s = summarizeToolInput('mcp__github__create_issue', { title: 't' }, CWD)
    expect(s.summary).toBe('github: create_issue')
    expect(s.input).toContain('"title"')
  })

  it('anything else: tool name + input JSON ≤96 chars, detail ≤4KiB', () => {
    const s = summarizeToolInput('MysteryTool', { a: 1 }, CWD)
    expect(s.summary).toBe('MysteryTool {"a":1}')
    const big = summarizeToolInput('MysteryTool', { blob: 'y'.repeat(10_000) }, CWD)
    expect(big.summary.length).toBe(96)
    expect(big.input!.length).toBeLessThanOrEqual(4096)
  })

  it('paths outside cwd stay absolute', () => {
    expect(summarizeToolInput('Read', { file_path: '/etc/hosts' }, CWD).summary).toBe('/etc/hosts')
  })
})

describe('summarizeToolOutput (§5.2)', () => {
  it('passes small strings through', () => {
    expect(summarizeToolOutput('Bash', 'ok')).toBe('ok')
  })

  it('caps at 4096: first 3072 + marker + last 1024', () => {
    const text = 'a'.repeat(3072) + 'MID'.repeat(1000) + 'z'.repeat(1024)
    const out = summarizeToolOutput('Bash', text)
    expect(out.startsWith('a'.repeat(3072))).toBe(true)
    expect(out.endsWith('z'.repeat(1024))).toBe(true)
    expect(out).toContain('chars truncated] …')
    const cut = text.length - 3072 - 1024
    expect(out).toContain(`[+${cut} chars truncated]`)
  })

  it('elides Read output to "<n> lines read"', () => {
    expect(summarizeToolOutput('Read', 'l1\nl2\nl3')).toBe('3 lines read')
    expect(summarizeToolOutput('Read', '')).toBe('0 lines read')
  })

  it('coerces content-block arrays and objects', () => {
    expect(
      coerceToolResponse([
        { type: 'text', text: 'part1' },
        { type: 'image', source: {} },
        { type: 'text', text: 'part2' },
      ]),
    ).toBe('part1\npart2')
    expect(coerceToolResponse({ content: 'inner' })).toBe('inner')
    expect(coerceToolResponse({ foo: 1 })).toBe('{\n  "foo": 1\n}')
    expect(coerceToolResponse(null)).toBe('')
    expect(coerceToolResponse(42)).toBe('42')
  })
})

describe('isMutatingTool', () => {
  it('read-only tools are not mutating; edit-shaped and unknown tools are', () => {
    for (const name of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TaskList', 'TodoWrite']) {
      expect(isMutatingTool(name)).toBe(false)
    }
    for (const name of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'mcp__db__migrate', 'Unknown']) {
      expect(isMutatingTool(name)).toBe(true)
    }
  })
})
