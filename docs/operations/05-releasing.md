---
title: "Releasing"
description: "How maintainers publish @rikalabs/akter and @rikalabs/akter-cli to npm with trusted publishing."
---

# Releasing

This page is for Akter maintainers. It explains how the framework (`@rikalabs/akter`) and the CLI (`@rikalabs/akter-cli`) reach npm. The two packages always release together at one version.

`.github/workflows/release.yml` publishes through npm trusted publishing (GitHub OIDC). No npm token is stored in the repository, and you must never create one for CI.

## Release channels

| Trigger                                                                  | Published as                                           | Dist-tag                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------- |
| Push a `v<version>` tag for a stable version such as `0.2.2`             | The version in the manifests                           | `latest`                                        |
| Push a `v<version>` tag for a pre-1.0 prerelease such as `0.3.0-alpha.1` | The version in the manifests                           | The prerelease id (`alpha`), then also `latest` |
| A successful `Verify` run on a push to `main`                            | A canary, `<version>-next.<run>.<attempt>.g<sha12>`    | `next`                                          |
| A push to `rewrite/0.2`                                                  | A canary, `<version>-rewrite.<run>.<attempt>.g<sha12>` | `rewrite`                                       |

`next` and `rewrite` never move `latest`. Registry tags, trusted-publisher settings, and environment approvals must be checked at release time, because editing the workflow publishes nothing.

## Prerequisites

- **Public repository and GitHub-hosted runner.** npm provenance is generated only for a public repository and rejects self-hosted runners. The job runs on `ubuntu-latest`.
- **Pinned toolchain.** The workflow uses Bun 1.4.2, Node 26.7.0, and npm 12.2.0.
- **Trusted publisher on both packages.** On npmjs.com, configure GitHub Actions with organization `Rika-Labs`, repository `akter`, workflow `release.yml`, and environment `npm`. Enable **Allow npm publish** and **Allow npm dist-tag**. Dist-tag permission is separate from publish permission. Every field must match exactly. See npm's [trusted publishing documentation](https://docs.npmjs.com/trusted-publishers).
- **`npm` environment.** Tagged releases and canaries both use it. Maintainers should require reviewers, prevent self-review, and disallow administrator bypass, then approve only after checking the exact verified SHA. If the environment restricts branches, allow `main`, `rewrite/0.2`, and `v*` tags.
- **Tag ruleset.** Add a ruleset for tags matching `v*` that restricts creation to the maintainers and blocks updates and deletions. A rebuild uses a new version and tag.

## Check a release candidate

From a clean checkout of the commit to release:

```sh
bun install --frozen-lockfile
bun run prepare
bun .github/src/pack.ts --out .local/package --cli-out .local/package-cli
SMOKE_RUNTIME=node bun .github/src/release/smoke.ts --package .local/package --cli-package .local/package-cli
SMOKE_RUNTIME=bun bun .github/src/release/smoke.ts --package .local/package --cli-package .local/package-cli
```

`pack.ts` stages both tarballs with `publishConfig` applied and `catalog:` versions resolved, copies `LICENSE` and `NOTICE`, and fails if the tarball is not publishable. The CLI tarball also carries the `@rikalabs/akter-cli/cloud-api` entry; `@akter/cloud-api` stays private.

`smoke.ts` installs both tarballs into a clean project and checks that:

- The framework typechecks, and its root, server, client, and testing entries run on the chosen runtime, serving `/rpc` to the Effect client over HTTP and WebSocket.
- The `cloud-api` types, endpoint, and schema checks pass.
- `akter --help` and `akter login --help` print.

## Publish a release

1. Set the same `version` in `packages/akter/package.json` and `apps/cli/package.json`, add the `CHANGELOG.md` entry in `packages/akter`, and land them on `main`. The release fails if the versions differ or the changelog has no section for the version.
2. Wait for a successful `Verify` run on that exact commit, then push the tag `v<version>` on it.
3. Approve the `npm` environment deployment. The job checks that the tag matches the manifest version, that the tagged commit is on `main`, and that a successful `Verify` (`ci.yml`) run exists for that commit. It then packs and smoke-tests both packages on Node and Bun before publishing.
4. The job runs `npm publish --provenance --access public` for each package whose version is not already on npm. After a pre-1.0 prerelease publishes, it moves `latest` to that version unless `latest` is already newer.
5. A separate job creates or updates the GitHub Release from the changelog section. Prereleases are marked as such. This job alone has `contents: write`.

To rerun an existing tag, select that tag as both the workflow ref and the `tag` input:

```sh
gh workflow run release.yml --ref v<version> -f tag=v<version>
```

Running from `main` against an older tag is refused, because provenance records the workflow's `GITHUB_SHA`.

Publishing and tagging are separate registry operations. If the second package or a tag update fails, fix the cause and rerun the same tag: published versions are skipped and promotion retries. Confirm the result:

```sh
npm view @rikalabs/akter dist-tags
npm view @rikalabs/akter-cli dist-tags
```

For a stable release, `latest` must name the new version on both packages, and `alpha`, `next`, and `rewrite` must be unchanged.

## Canaries

`release.yml` also runs after a completed `Verify` workflow on `main`. Only a successful `push` run of this repository's `ci.yml` publishes. Pull request runs (including forks), failed or cancelled runs, and manual runs do not. A run is skipped when its commit is not the default branch's current commit.

A canary uses the same environment, runner, pack checks, and smoke tests as a release. It skips the GitHub Release. Source manifests and changelogs are not changed. Canaries publish only to `next`, and a push to `rewrite/0.2` publishes only to `rewrite`. That branch's job waits up to 30 minutes for a successful `Verify` run on the pushed commit.

To stage a canary locally:

```sh
bun .github/src/pack.ts --out .local/next --cli-out .local/next-cli --canary 321.1.g123456abcdef
```

Add `--canary-channel rewrite` for the `rewrite` channel. Install `@next` to try a canary, but pin the same full version of both packages in any deployment.

## Add a new package

The workflow publishes packages that already exist on npm and have a configured trusted publisher. Both current packages do. For any new published package, make the first publish by hand from a validated tarball with interactive `npm login` and 2FA, then configure its trusted publisher. A manual publish has no provenance. Never commit a publish token, and revoke any you create.

## Limits

- A version already on npm is immutable. Rerunning its tag runs the checks, then skips `npm publish`. A changed build needs a new version.
- React and Python clients are not part of 0.2. The public client is Effect-only.
- Release checks do not certify a storage provider. See the [support matrix](./support-matrix.md).
