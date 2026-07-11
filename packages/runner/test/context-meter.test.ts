/**
 * context-meter tests: the §10 formula, dedupe, compaction/clear resets, streaming
 * estimate behavior, exact-occupancy override.
 */

import { describe, expect, it } from 'vitest'
import { ContextMeter, usageContextTokens } from '../src/sessions/claude/context-meter'

describe('usageContextTokens', () => {
  it('sums input + cache_read + cache_creation + output', () => {
    expect(
      usageContextTokens({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 30,
      }),
    ).toBe(1180)
  })

  it('treats missing/null fields as 0', () => {
    expect(usageContextTokens({ input_tokens: 5 })).toBe(5)
    expect(usageContextTokens({})).toBe(0)
    expect(usageContextTokens({ output_tokens: null })).toBe(0)
  })
})

describe('ContextMeter', () => {
  it('commits per complete assistant message with message-id dedupe', () => {
    const m = new ContextMeter()
    expect(m.value()).toBe(0)
    expect(
      m.commitAssistantUsage('msg_1', {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 0,
      }),
    ).toBe(true)
    expect(m.value()).toBe(620)
    // duplicate id (parallel tool calls) — ignored
    expect(
      m.commitAssistantUsage('msg_1', {
        input_tokens: 999_999,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ).toBe(false)
    expect(m.value()).toBe(620)
  })

  it('streaming estimate: message_start base + message_delta output, never below committed', () => {
    const m = new ContextMeter()
    m.commitAssistantUsage('msg_1', { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
    expect(m.value()).toBe(1000)

    m.onMessageStart({ input_tokens: 1100, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 })
    expect(m.value()).toBe(1300)
    m.onStreamingOutputTokens(50)
    expect(m.value()).toBe(1350)
    m.onStreamingOutputTokens(80)
    expect(m.value()).toBe(1380)
    // output token counters never regress
    m.onStreamingOutputTokens(10)
    expect(m.value()).toBe(1380)

    // complete message resets to the authoritative figure
    m.commitAssistantUsage('msg_2', { input_tokens: 1200, output_tokens: 90, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 })
    expect(m.value()).toBe(1490)
  })

  it('compact boundary freezes at pre_tokens, next assistant message resets downward', () => {
    const m = new ContextMeter()
    m.commitAssistantUsage('msg_1', { input_tokens: 150_000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
    m.onCompactBoundary(150_500)
    expect(m.value()).toBe(150_500)
    m.commitAssistantUsage('msg_2', { input_tokens: 8_000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
    expect(m.value()).toBe(8_200)
  })

  it('/clear resets to 0', () => {
    const m = new ContextMeter()
    m.commitAssistantUsage('msg_1', { input_tokens: 5000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
    m.reset()
    expect(m.value()).toBe(0)
  })

  it('setExact overrides the formula value (getContextUsage totalTokens)', () => {
    const m = new ContextMeter()
    m.commitAssistantUsage('msg_1', { input_tokens: 5000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
    m.setExact(4321)
    expect(m.value()).toBe(4321)
  })
})
