/**
 * Secret redaction on outbound payload strings (04 §13, 08 §4 — the pattern
 * table there is canonical; the conformance fixtures live in
 * `packages/runner-protocol/fixtures/redaction/*.json`).
 *
 * A single `redact(text)` applied to every outbound payload string before it
 * enters the outbox/WsClient: tool output, tool input echoes, diff lines,
 * error text/stderr. Assistant/thinking text is EXCLUDED (model output;
 * redacting it breaks transcripts). Replacement token: `[redacted:<label>]`.
 *
 * Redaction runs BEFORE truncation so a size cap can never split a secret
 * past a pattern (04 §13).
 */

import type { DeltaPayload, WireSessionEvent } from '@yasui.io/runner-protocol'

interface Pattern {
  label: string
  regex: RegExp
  /** Replacement; defaults to `[redacted:<label>]` for the whole match. */
  replacement?: string
}

/**
 * Pattern table — 08 §4 verbatim, in application order. `session-key-exact`
 * (the literal current session inference key) is checked first, before any of
 * these (cheapest and highest value).
 */
export const REDACT_PATTERNS: readonly Pattern[] = [
  {
    label: 'private-key',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    label: 'bearer-header',
    // (?i) keep group 1 (the `authorization: bearer` prefix).
    regex: /\b(authorization\s*:\s*bearer)\s+\S+/gi,
    replacement: '$1 [redacted:bearer-header]',
  },
  {
    label: 'env-assignment',
    // (?im) keep the var name.
    regex: /^(\s*(?:export\s+)?)([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)(\s*=\s*)\S+/gim,
    replacement: '$1$2$3[redacted:env-assignment]',
  },
  { label: 'aws-key-id', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'aws-secret', regex: /aws.{0,20}?['"][0-9a-zA-Z/+]{40}['"]/gi },
  { label: 'github-token', regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { label: 'anthropic-key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'openai-key', regex: /\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/g },
  { label: 'openai-key', regex: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'yasui-key', regex: /\byk_(?:live|test)_[A-Za-z0-9_-]{10,}\b/g },
  { label: 'yasui-runner-token', regex: /\byr_[A-Za-z0-9_-]{10,}\b/g },
  {
    label: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
]

/* ---------- Session-key exact-match registry ----------
 * The session-scoped inference key from `session.start` never touches disk;
 * SessionManager registers it here for the session's lifetime so any tool
 * output that echoes env (08 T6d) is scrubbed with an exact match first. */

const sessionSecrets = new Map<string, string>()

export function registerSessionSecret(sessionId: string, secret: string): void {
  if (secret.length >= 8) sessionSecrets.set(sessionId, secret)
}

export function unregisterSessionSecret(sessionId: string): void {
  sessionSecrets.delete(sessionId)
}

/** Test/introspection helper. */
export function registeredSecretCount(): number {
  return sessionSecrets.size
}

/** The single redaction pass (08 §4). Order: exact session keys → pattern table. */
export function redact(text: string): string {
  if (text.length === 0) return text
  let out = text
  for (const secret of sessionSecrets.values()) {
    if (out.includes(secret)) out = out.split(secret).join('[redacted:session-key]')
  }
  for (const pattern of REDACT_PATTERNS) {
    pattern.regex.lastIndex = 0
    out = out.replace(pattern.regex, pattern.replacement ?? `[redacted:${pattern.label}]`)
  }
  return out
}

/* ---------- Structured helpers ---------- */

/** Deep-redact every string in a JSON-ish value (tool inputs, error details). */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v)
    return out as unknown as T
  }
  return value
}

/**
 * Redact a WireSessionEvent before it enters the outbox. Assistant/thinking
 * events pass through untouched (excluded per 08 §4); everything else has all
 * string payload fields scrubbed.
 */
export function redactEvent(event: WireSessionEvent): WireSessionEvent {
  if (event.kind === 'assistant' || event.kind === 'thinking') return event
  return redactDeep(event)
}

/** Deltas: assistant/thinking targets are model output (excluded); tool-output is redacted. */
export function redactDelta(delta: DeltaPayload): DeltaPayload {
  if (delta.target === 'tool-output') return { ...delta, text: redact(delta.text) }
  return delta
}
