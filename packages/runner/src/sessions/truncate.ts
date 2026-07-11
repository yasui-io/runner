/**
 * Outbound size caps (02 §11): tool output in a `tool` event is truncated
 * head+tail at 64 KiB with a `… [truncated N bytes] …` marker; an `event`
 * payload over 256 KiB has its text fields truncated with `truncated: true`
 * set inside the affected object. Redaction runs BEFORE this (04 §13) — a cap
 * can never split a secret past a pattern.
 */

import { RELAY_LIMITS, type ToolCall, type WireSessionEvent } from '@yasui.io/runner-protocol'

/** Head+tail truncation with byte marker (02 §11 tool-output rule). */
export function truncateHeadTail(text: string, maxBytes: number): string {
  const total = Buffer.byteLength(text)
  if (total <= maxBytes) return text
  const keep = Math.max(256, Math.floor((maxBytes - 64) / 2))
  const head = Buffer.from(text).subarray(0, keep).toString()
  const tail = Buffer.from(text).subarray(total - keep).toString()
  return `${head}\n… [truncated ${total - keep * 2} bytes] …\n${tail}`
}

function capToolCall(call: ToolCall): ToolCall {
  const out = { ...call }
  if (out.output && Buffer.byteLength(out.output) > RELAY_LIMITS.maxToolOutputBytes) {
    out.output = truncateHeadTail(out.output, RELAY_LIMITS.maxToolOutputBytes)
  }
  if (out.input && Buffer.byteLength(out.input) > RELAY_LIMITS.maxToolOutputBytes) {
    out.input = truncateHeadTail(out.input, RELAY_LIMITS.maxToolOutputBytes)
  }
  if (out.errorText && Buffer.byteLength(out.errorText) > RELAY_LIMITS.maxToolOutputBytes) {
    out.errorText = truncateHeadTail(out.errorText, RELAY_LIMITS.maxToolOutputBytes)
  }
  return out
}

/**
 * Enforce the event payload cap. The adapter already truncates per 05; this
 * is the runner core's safety net so no frame can exceed 02 §11 limits.
 */
export function capEvent(event: WireSessionEvent): WireSessionEvent {
  let out: WireSessionEvent = event
  if (out.kind === 'tool') out = { ...out, call: capToolCall(out.call) }
  else if (out.kind === 'tool-group') out = { ...out, calls: out.calls.map(capToolCall) }

  const fits = (e: WireSessionEvent) => Buffer.byteLength(JSON.stringify(e)) <= RELAY_LIMITS.maxEventBytes
  if (fits(out)) return out

  // Oversized payloads with a dominant top-level text field.
  const truncatable = out as WireSessionEvent & { text?: string; truncated?: boolean }
  if (typeof truncatable.text === 'string') {
    out = {
      ...truncatable,
      text: truncateHeadTail(truncatable.text, Math.floor(RELAY_LIMITS.maxEventBytes * 0.9)),
      truncated: true,
    } as unknown as WireSessionEvent
    if (fits(out)) return out
  }

  // Bulk outside `text` — e.g. the permission event's wire-only `input` (the
  // raw canUseTool input; display-only, the dock shows `request`). Shrink
  // every oversized string leaf until the frame fits, `truncated: true` on the
  // event (02 §11). An over-cap durable frame would otherwise poison the
  // outbox: the relay's 1 MiB limit kills the socket and redelivery re-sends
  // the same frame on every reconnect.
  for (let leafCap: number = RELAY_LIMITS.maxToolOutputBytes; leafCap >= 1024; leafCap = Math.floor(leafCap / 4)) {
    out = { ...(truncateStringLeaves(out, leafCap) as WireSessionEvent), truncated: true } as unknown as WireSessionEvent
    if (fits(out)) return out
  }
  // Structural pathology (bulk is JSON structure, not strings): drop the
  // display-only permission fields rather than ship an over-cap frame.
  if (out.kind === 'permission') {
    return { ...out, input: {}, suggestions: [], truncated: true } as WireSessionEvent
  }
  return out
}

/** Deep map: head+tail-truncate every string leaf larger than maxBytes. */
function truncateStringLeaves(value: unknown, maxBytes: number): unknown {
  if (typeof value === 'string') {
    return Buffer.byteLength(value) > maxBytes ? truncateHeadTail(value, maxBytes) : value
  }
  if (Array.isArray(value)) return value.map((v) => truncateStringLeaves(v, maxBytes))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = truncateStringLeaves(v, maxBytes)
    return out
  }
  return value
}
