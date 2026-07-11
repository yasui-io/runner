# Self-hosting notes

The runner is a single outbound-only daemon — it never listens on the network
(the only local socket is a unix domain control socket under
`~/.yasui-runner/state/`).

## Firewall / egress

Allow outbound HTTPS (443) to:

- `api.yasui.io` — REST (pairing, token rotation) and the relay WebSocket
  (`wss://api.yasui.io/relay/v1`). The WS is long-lived with a 20 s heartbeat;
  intermediaries must allow idle > 60 s on upgraded connections.
- `registry.npmjs.org` — self-update (staged installs verified with
  `npm audit signatures`).
- `nodejs.org` — only during install, when no system Node >= 20 exists.

Nothing else. CI greps the codebase for network calls to any other host —
the runner has zero telemetry.

## Resource sizing

- Idle: a few tens of MB RSS, negligible CPU.
- Per active session: one Claude Code subprocess (typically 200–500 MB RSS
  under load) plus git subprocesses. Size `maxConcurrentSessions`
  (config.json, default 2) to your machine.
- Disk: logs rotate at 10 MiB × 5; outbox spillover is bounded at 32 MiB per
  session; keep ≥ 1 GiB free (`yasui-runner doctor` checks).

## Headless VPS checklist

1. Create a dedicated user; install as that user (no sudo needed).
2. `yasui-runner connect --code …` then `yasui-runner install-service`.
3. `loginctl enable-linger <user>` so the systemd user unit survives logout.
4. `yasui-runner doctor` — everything should be ✔.
