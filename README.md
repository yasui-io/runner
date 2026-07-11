# yasui-runner

The open-source Yasui agent host: a TypeScript daemon that dials out to
`wss://api.yasui.io/relay/v1` and runs coding-agent sessions (Claude Code first) on your
own machine, driven from the Yasui web UI.

Two packages:

- **`@yasui.io/runner-protocol`** — the `relay/v1` wire protocol: JSON-serializable types,
  zod schemas, and the conformance fixtures that keep the control plane's schema copy
  honest.
- **`@yasui.io/runner`** — the daemon + `yasui-runner` CLI (depends on `runner-protocol`).

## Install

```sh
curl -fsSL https://yasui.io/runner.sh | sh
```

## Monorepo staging note

This workspace is destined for the standalone `yasui-io/runner` repo. It is temporarily
staged inside the Yasui monorepo at `./runner/` while the agents system lands, but it is
fully self-contained: it is **not** part of the monorepo's root workspaces and has
**zero imports from `apps/*`** (enforced at extraction). Do not add any.

## Development

```sh
bun install
bun run typecheck
bun run test
```

License: Apache-2.0.
