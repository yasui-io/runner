# Security

Report vulnerabilities to security@yasui.io (90-day coordinated disclosure;
scope: this repo + the relay protocol). No bounty program yet.

## What leaves your machine

The agent transcript — your prompts, the model's output, tool results, and
git diffs (which include your source code) — is sent to Yasui so you can
drive and review sessions from the browser. Yasui stores this for 90 days or
until you delete the session. A secret-redaction pass strips common
credential patterns before anything is sent (disable with
`yasui-runner config set redaction off`). Yasui never receives your git
credentials, SSH keys, or files outside the tool outputs and diffs shown in
the UI.

Specifically never sent: the `yr_` runner token (except the pair exchange and
the WS auth header), the session inference key (used only inside harness API
calls), environment variables, ssh keys/credential helpers, harness
transcripts (`~/.yasui-runner/claude/projects/…` stays local), absolute paths
outside your configured roots, and log lines.

## Token handling

- `~/.yasui-runner/config.json` is the ONLY file containing the runner token;
  written 0600 via temp-file + rename; the runner refuses to start when the
  file is group/world-readable.
- The session-scoped inference key arrives over the authenticated WS and
  lives only in process memory + the harness subprocess env — never on disk.
- Rotate with `yasui-runner rotate-token`; revoke from the web dashboard.

## What the control plane can and cannot make this machine do

The inbound surface is a closed, typed command set validated with zod:
session lifecycle, user messages, permission verdicts, a whitelisted git
executor (fixed argv templates, `execFile` only, path-confined to your
configured roots), a project rescan, and an *update nudge*. The control plane
cannot push code: `runner.update` carries only a version string — the runner
fetches that version from the npm registry itself and refuses anything that
fails `npm audit signatures` (Sigstore provenance). `bypassPermissions` can
only be enabled from this machine's CLI (`config set allow-bypass on`),
never from the web.
