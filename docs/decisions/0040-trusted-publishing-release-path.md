# ADR 0040: Trusted publishing and the first-release bootstrap

**Status:** accepted (2026-09-26). Dallen chose npm trusted publishing over a long-lived npm token and a manual first publish from his machine. It amends the "How releases happen" part of [ADR 0029](0029-licence-package-name-and-release-policy.md).

**Responsibility:** decide how published packages authenticate to npm and how a new package's first version is published.

**Authority:** design decision record.

**Owner role:** API and release.

**Change policy:** supersede through a new ADR.

The 2026-10-08 launch amendment in [ADR 0029](0029-licence-package-name-and-release-policy.md) adds verified-main `next` canaries in the same workflow and automated pre-1.0 `latest` promotion. npm 12.2.0 supports OIDC dist-tag changes; both trusted publishers must permit `npm publish` and `npm dist-tag`. The authentication, hosted-runner and manual-bootstrap decisions below are unchanged.

## Context

ADR 0029 left the publish workflow and the first publish to CR.1b (#99). The first workflow draft authenticated with an `NPM_TOKEN` repository secret. A long-lived publish token can be copied out of the environment and used anywhere. npm trusted publishing instead trusts one GitHub repository, workflow file and environment, and exchanges the job's OIDC identity for a short-lived credential, but it can only be configured on a package that already exists on npm.

## Decision

- **Workflow releases use trusted publishing.** `release.yml` runs on a pushed `v*` tag or by manual dispatch with a `tag` input, on a GitHub-hosted runner, in the `npm` environment, with `id-token: write` and `contents: read`. It checks the tag against the manifest version and that the tagged commit is on `main`, stages and checks the tarball, runs the clean-consumer smoke test, and runs `npm publish --provenance --access public` with the dist-tag taken from the prerelease identifier. No npm token or publish secret is configured anywhere.
- **The first version of a new package is published by hand.** A maintainer stages the tarball with `bun .github/src/pack.ts`, runs `npm publish --access public` from the staged directory after `npm login` with 2FA, and then configures the package's trusted publisher (`Rika-Labs` / `akter` / `release.yml` / `npm`). Token publishing may then be disallowed on the package. [Releasing](../operations/05-releasing.md) is the procedure.
- **Provenance needs a public repository.** Workflow releases carry npm provenance, which requires the repository to be public; the bootstrap version does not carry it.

## Alternatives

- **`NPM_TOKEN` secret scoped to the `npm` environment.** Works for the first publish, but leaves a long-lived credential that outlives the workflow and must be rotated.
- **Publish the first version from CI with a temporary token.** Avoids the manual step but still mints and stores a token once; the manual publish uses the maintainer's interactive 2FA instead.

## Consequences

- The repository must be public before the first workflow release.
- Every new published package (the scaffolder in CR.2, `@akter/react` in CR.6) needs its own manual bootstrap and trusted-publisher entry.

## Evidence

`bun .github/src/pack.ts` and `bun .github/src/release/smoke.ts` pass on the release candidate. The workflow itself is only exercised by a real release; it has not run.

## Revisit when

- npm allows configuring a trusted publisher before a package's first version.
- A release needs to publish from a runner other than GitHub-hosted Actions.
