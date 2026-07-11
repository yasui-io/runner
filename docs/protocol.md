# relay/v1 — protocol overview

Human-readable summary of the wire protocol between `yasui-runner` and the
Yasui control plane. The machine-readable source of truth is
`packages/runner-protocol/src/index.ts` (zod schemas) plus the conformance
fixtures in `packages/runner-protocol/fixtures/` — third parties building a
runner should code against those.

## Connection

- One outbound WebSocket per runner: `GET wss://api.yasui.io/relay/v1` with
  `Authorization: Bearer yr_<token>` and `x-yasui-runner-version`.
- Browsers can never open the relay: any upgrade carrying an `Origin` header
  is rejected before the handshake.
- First frame MUST be `hello` (runner → server); the server answers
  `hello.ack` before anything else. Version negotiation:
  `min(server.protocolVersion, runner.protocolVersion)`; incompatible → close
  `4002`.
- Reconnect with exponential backoff 1 s → 30 s cap, full jitter, reset after
  60 s stable.

## Frame envelope

Single JSON text messages: `{ id, type, sessionId?, seq?, ts, payload }`.
`id` is the sender-generated idempotency/ack key. `seq` is server-assigned
only. Unknown frame types and unknown payload fields are ignored (additive
compatibility); the one strict rejection is an `attachments` key on
`session.message`/`session.slash`.

## Frame catalog

Runner → server: `hello`, `heartbeat`, `event`, `delta`, `session.started`,
`session.status`, `session.stats`, `session.diff`, `session.ended`,
`git.result`, `project.list`, `runner.config`, `cmd.ack`, `error`.

Server → runner: `hello.ack`, `heartbeat.ack`, `event.ack`, `session.start`,
`session.message`, `session.slash`, `session.interrupt`, `session.setModel`,
`session.setPermissionMode`, `permission.verdict`, `git.request`,
`project.scan`, `session.end`, `runner.update`, `error`.

## Delivery guarantees

- `event` frames are at-least-once: buffered in a per-session outbox
  (memory + JSONL spillover) until `event.ack`; the server dedupes on the
  frame id. Never dropped — at 5 000 frames / 32 MiB the runner pauses the
  harness instead.
- `delta`, `session.stats`, `session.diff` are droppable (latest wins);
  deltas are reconstructible from consolidated `event` revisions.
- Server commands are acked with `cmd.ack` (batched ≤ 50 ms) and deduped
  against a per-session LRU of 1 024 applied frame ids.

## Heartbeat

Application-level: runner sends `heartbeat` every `hello.ack.heartbeatIntervalMs`
(20 s) with `{ activeSessions, load1, freeMemMb }`; a missing `heartbeat.ack`
for 10 s tears the link down.

## Size limits

| Limit | Value |
| --- | --- |
| WS message | 1 MiB |
| `event` payload | 256 KiB |
| Tool output inside a `tool` event | 64 KiB (head+tail truncation) |
| `delta.text` | 8 KiB |
| `diff.file` hunks | 512 KiB (`truncated: true` past that) |

## Close codes

| Code | Meaning | Runner behavior |
| --- | --- | --- |
| 1000 | normal shutdown | reconnect (unless self-initiated) |
| 1012 | server restarting | reconnect immediately |
| 1013 | server overloaded | reconnect with backoff |
| 4001 | unauthorized | re-read config once (token rotation), else re-pair |
| 4002 | protocol version unsupported | exit; update the runner |
| 4003 | superseded by a newer connection | exit 0, no reconnect |
| 4004 | rate limited | reconnect after ≥ 30 s |
| 4008 | protocol violation | backoff reconnect |
| 4009 | frame too large (repeated) | backoff reconnect |
| 4013 | runner deleted/banned | exit 0; re-pair required |
