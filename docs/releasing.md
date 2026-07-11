+# Publishing releases

This repository publishes two public npm packages from one versioned release:

1. `@yasui.io/runner-protocol`
2. `@yasui.io/runner`, which depends on the exact protocol version

Publish the protocol first. Keep both package versions identical.

## One-time setup

The releaser needs:

- admin access to `yasui-io/runner`
- owner or maintainer access to the npm `yasui.io` organization
- Bun 1.3.14, Node.js 22, npm, and GitHub CLI
- `gh auth status` and `npm whoami` returning the intended accounts

The release workflow expects an npm automation token in the GitHub repository secret
`NPM_TOKEN`. Create a granular token limited to the `yasui.io` organization, then set
it without printing it:

```sh
gh secret set NPM_TOKEN --repo yasui-io/runner
```

Prefer an npm trusted publisher when it is available for the organization. After
configuring trusted publishing for `yasui-io/runner` and
`.github/workflows/release.yml`, remove `NODE_AUTH_TOKEN` from the workflow and delete
the repository secret.

## Prepare a release

Set `VERSION` without a leading `v`:

```sh
VERSION=0.2.0
```

Update all three version references:

- `packages/runner-protocol/package.json` → `version`
- `packages/runner/package.json` → `version`
- `packages/runner/package.json` → dependency
  `@yasui.io/runner-protocol`

Then refresh and validate the workspace:

```sh
bun install
bun run typecheck
bun run test
bun run build
npm pack --dry-run ./packages/runner-protocol
npm pack --dry-run ./packages/runner
git diff --check
```

Confirm the version is not already published:

```sh
npm view "@yasui.io/runner-protocol@$VERSION" version
npm view "@yasui.io/runner@$VERSION" version
```

A 404 is expected for a new version. Any returned version means the number must be
changed; npm versions cannot be overwritten.

Commit and push the release preparation, then wait for CI:

```sh
git add package.json bun.lock packages
git commit -m "release: v$VERSION"
git push origin main
gh run watch --repo yasui-io/runner --exit-status
```

## Publish

Create and push the matching tag only after `main` is green:

```sh
git tag -s "v$VERSION" -m "v$VERSION"
git push origin "v$VERSION"
gh run watch --repo yasui-io/runner --exit-status
```

The tag workflow:

- rejects a tag that does not match both package versions
- builds and tests from a frozen lockfile
- publishes protocol before runner with npm provenance
- skips a package that already exists, making retries safe after partial publication
- replaces installer checksum placeholders with Node release hashes
- attaches the pinned `runner.sh` to the GitHub release

If signed tags are not configured locally, use an annotated tag with
`git tag -a` and record that exception in the release notes.

## Verify

```sh
npm view "@yasui.io/runner-protocol@$VERSION" version dist.integrity
npm view "@yasui.io/runner@$VERSION" version dist.integrity
npm audit signatures
gh release view "v$VERSION" --repo yasui-io/runner
```

Also install into a disposable prefix and run the CLI:

```sh
TMP_PREFIX="$(mktemp -d)"
npm install --prefix "$TMP_PREFIX" "@yasui.io/runner@$VERSION"
"$TMP_PREFIX/node_modules/.bin/yasui-runner" --version
rm -rf "$TMP_PREFIX"
```

Do not delete or force-move a published tag. Fix release defects with a new patch version.

