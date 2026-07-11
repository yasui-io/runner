# relay/v1 conformance fixtures

These fixtures are the compatibility contract between the two schema copies
(`@yasui.io/runner-protocol` and `apps/api/src/agents/protocol.ts`). Both repos parse every
file here with their own zod schemas and must reach identical accept/reject outcomes. A
PR changing either schema copy must update fixtures in the same change; removing or
renaming a fixture requires a `PROTOCOL_VERSION` bump (02-wire-protocol.md §12).

## Format

Each frame fixture is:

```jsonc
{
  "direction": "runner->server" | "server->runner",  // which union parses it
  "frame": { … },                                    // the wire frame verbatim
  "expect": "accept" | "reject"                      // required parse outcome
}
```

The `expect` key is this repo's documented extension of the 02 §12 format (which only
specifies `direction` + `frame`): it makes the invalid cases — the `attachments`
denylist rejection, malformed envelopes, bad hello shapes — first-class fixtures instead
of a side convention. Files named `invalid.*` all carry `"expect": "reject"`.

`close-codes.json` is not a frame fixture: it snapshots the WS close-code and
`yasui_*` error-code taxonomy so a rename in either copy fails the suite.
