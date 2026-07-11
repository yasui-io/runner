/**
 * `contextUsedTokens` computation (05 §10).
 *
 * Decision formula — after each complete assistant message (deduped by message id):
 *
 *   contextUsedTokens = input_tokens + cache_read_input_tokens
 *                     + cache_creation_input_tokens + output_tokens
 *
 * i.e. the full prompt the model just saw (cache tokens ARE context) plus its reply.
 *
 * Verify-against-SDK note (05 §10): the installed SDK DOES expose exact window
 * occupancy — `Query.getContextUsage()` → `SDKControlGetContextUsageResponse.totalTokens`.
 * The adapter refreshes from it after each result (`setExact`), preferring the exact
 * figure; the formula remains the live per-step source between refreshes.
 *
 * Streaming input (§5 table: `message_start` / `message_delta` are "context meter input
 * only"): `message_start` usage carries the fresh prompt size (input + cache tokens) and
 * `message_delta` the cumulative output tokens, so a live in-flight estimate is
 * base + partialOut. The reported value only moves up mid-turn (monotonic per turn);
 * `compact_boundary` freezes it at `pre_tokens` until the next complete message resets
 * it, `/clear` resets to 0.
 */

export interface UsageLike {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

function n(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function usageContextTokens(usage: UsageLike): number {
  return (
    n(usage.input_tokens) +
    n(usage.cache_read_input_tokens) +
    n(usage.cache_creation_input_tokens) +
    n(usage.output_tokens)
  )
}

export class ContextMeter {
  private committed = 0
  private pendingBase = 0
  private pendingOut = 0
  private pendingActive = false
  private seenMessageIds = new Set<string>()

  /** Fresh request began streaming — usage from the `message_start` event. */
  onMessageStart(usage: UsageLike): void {
    this.pendingBase = n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens)
    this.pendingOut = 0
    this.pendingActive = true
  }

  /** Cumulative output tokens from `message_delta` usage. */
  onStreamingOutputTokens(outputTokens: number | null | undefined): void {
    if (!this.pendingActive) return
    this.pendingOut = Math.max(this.pendingOut, n(outputTokens))
  }

  /**
   * Complete assistant message — authoritative per-step reset. Deduped by message id
   * (parallel tool calls repeat the same id with identical usage, sdk-sessions §5).
   * Returns false for duplicates.
   */
  commitAssistantUsage(messageId: string, usage: UsageLike): boolean {
    if (this.seenMessageIds.has(messageId)) return false
    this.seenMessageIds.add(messageId)
    this.committed = usageContextTokens(usage)
    this.pendingActive = false
    this.pendingBase = 0
    this.pendingOut = 0
    return true
  }

  /** Freeze at pre_tokens; the next complete assistant message resets it (05 §10). */
  onCompactBoundary(preTokens: number): void {
    this.committed = n(preTokens)
    this.pendingActive = false
    this.pendingBase = 0
    this.pendingOut = 0
  }

  /** Exact occupancy from `Query.getContextUsage().totalTokens` — preferred when available. */
  setExact(totalTokens: number): void {
    this.committed = n(totalTokens)
    this.pendingActive = false
    this.pendingBase = 0
    this.pendingOut = 0
  }

  /** `/clear` — context reset to empty (05 §7/§10). */
  reset(): void {
    this.committed = 0
    this.pendingBase = 0
    this.pendingOut = 0
    this.pendingActive = false
  }

  value(): number {
    if (this.pendingActive) {
      const live = this.pendingBase + this.pendingOut
      // Only move up mid-turn; post-compaction streams stay frozen at pre_tokens
      // until the complete message resets committed downward.
      return Math.max(this.committed, live)
    }
    return this.committed
  }
}
