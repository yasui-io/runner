# Redactor conformance fixtures (04 §13, 08 §4)

One file per pattern label from the canonical table in 08-security-ops.md §4,
plus `session-key-exact.json` (the literal current session inference key,
checked first) and `combined.json` (multiple secrets in one payload,
truncation-adjacent shapes).

## Format

```jsonc
{
  "label": "aws-key-id",              // pattern label — replacement token is [redacted:<label>]
  "cases": [
    {
      "name": "bare key id",
      "input": "creds: AKIAIOSFODNN7EXAMPLE done",
      "expected": "creds: [redacted:aws-key-id] done",
      "sessionSecrets": ["…"]          // optional — registered as session-key exact matches first
    }
  ]
}
```

Consumed by `packages/runner/test/redact.test.ts` and by
`yasui-runner selfcheck` (the self-update smoke step). These fixtures are
runner-side only — the control plane never redacts (the runner is the privacy
boundary), so they are not part of the vendored `apps/api` fixture set.
