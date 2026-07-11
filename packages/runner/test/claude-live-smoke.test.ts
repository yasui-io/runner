/**
 * Live smoke test (05 §12) — real SDK subprocess against a local mock gateway that
 * speaks the Anthropic Messages SSE protocol. No monorepo api required.
 *
 * Skipped by default: set YASUI_CLAUDE_LIVE_SMOKE=1 to run. It spawns the bundled
 * Claude Code binary, so it needs the platform optional dependency installed and
 * ~10 s of wall clock.
 *
 *   YASUI_CLAUDE_LIVE_SMOKE=1 bunx vitest run test/claude-live-smoke.test.ts
 */

import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AdapterOutput } from '../src/sessions/harness-adapter'
import { ClaudeCodeAdapter } from '../src/sessions/claude/claude-adapter'

const LIVE = process.env.YASUI_CLAUDE_LIVE_SMOKE === '1'

function sseBody(): string {
  const events: Array<[string, Record<string, unknown>]> = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_mock_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello from the mock gateway.' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

describe.skipIf(!LIVE)('claude adapter live smoke (mock Anthropic-Messages gateway)', () => {
  let server: Server
  let baseUrl = ''
  let configDir = ''
  let projectDir = ''

  beforeAll(async () => {
    configDir = mkdtempSync(join(tmpdir(), 'yasui-smoke-config-'))
    projectDir = mkdtempSync(join(tmpdir(), 'yasui-smoke-proj-'))
    server = createServer((req, res) => {
      if (req.method === 'POST' && req.url?.includes('/messages')) {
        req.resume()
        req.on('end', () => {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          })
          res.end(sseBody())
        })
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":{"type":"not_found_error","message":"mock: unknown route"}}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address && typeof address === 'object') baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(configDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  })

  it(
    'init → send → assistant event → result → stop',
    async () => {
      const adapter = new ClaudeCodeAdapter()
      const outputs: AdapterOutput[] = []
      const started = await adapter.start({
        sessionId: 'ags_smoke',
        projectPath: projectDir,
        projectTrusted: false,
        model: process.env.YASUI_CLAUDE_SMOKE_MODEL ?? 'claude-sonnet-4-5',
        contextWindowTokens: 200_000,
        permissionMode: 'default',
        permissionTimeoutMinutes: 1,
        systemPromptAppend: null,
        maxTurns: 2,
        maxBudgetUsd: 1,
        resumeHarnessSessionId: null,
        inference: { baseUrl, authToken: 'yk_mock' },
        paths: { claudeConfigDir: configDir, sessionLog: join(configDir, 'smoke.log') },
      })
      expect(started.harnessSessionId).toBeTruthy()
      expect(started.tools.length).toBeGreaterThan(0)

      const drain = (async () => {
        for await (const out of adapter.output()) outputs.push(out)
      })()

      await adapter.send({ kind: 'message', eventId: 'ev_smoke_1', text: 'Say hello.' })

      // wait for an assistant event to land, then end the session
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        if (
          outputs.some(
            (o) => o.type === 'event' && o.event.kind === 'assistant' && (o.event as { text: string }).text.length > 0,
          )
        ) {
          break
        }
        await new Promise((r) => setTimeout(r, 250))
      }
      await adapter.stop('user')
      await drain

      const assistantEvents = outputs.filter((o) => o.type === 'event' && o.event.kind === 'assistant')
      expect(assistantEvents.length).toBeGreaterThan(0)
      expect(outputs[outputs.length - 1]).toMatchObject({ type: 'ended' })
    },
    120_000,
  )
})
