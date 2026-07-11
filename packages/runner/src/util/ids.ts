/**
 * Collision-resistant id generation (cuid2-shaped, dependency-free).
 *
 * Frame envelopes require ids of 8–64 chars (02 §5). We generate
 * `<prefix>_<24 base36 chars>` from CSPRNG bytes — the same shape and entropy
 * class as cuid2 without pulling in a dependency.
 */

import { randomBytes } from 'node:crypto'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function randomBase36(length: number): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[(bytes[i] as number) % 36]
  return out
}

/** `createId('f')` → `f_k2j9x…` (26 chars total for a 1-char prefix). */
export function createId(prefix: string): string {
  return `${prefix}_${randomBase36(24)}`
}

/** Frame id — idempotency + ack key on the wire. */
export const frameId = () => createId('f')
/** Logical wire event id (revisions reuse it). */
export const eventId = () => createId('ev')
/** RPC correlation id. */
export const opId = () => createId('op')
