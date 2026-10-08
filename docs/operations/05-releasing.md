---
title: "Releasing"
description: "Publish framework and CLI releases and main canaries through npm trusted publishing."
---

# Releasing

**Responsibility:** publish `@rikalabs/akter` and `@rikalabs/akter-cli` to npm and bootstrap the npm trusted publishers.
**Authority:** operational.
**Owner role:** API and release.
**Change policy:** a change requires operator review when a procedure or limit changes.

## Status

At launch preparation, `@rikalabs/akter` has `alpha: 0.1.0-alpha.1` and `latest: 0.1.0-alpha.0`; `@rikalabs/akter-cli` still needs its first publish. The framework was bootstrapped by hand on 2026-10-04, and its trusted publisher names `Rika-Labs/akter`'s `release.yml` and the `npm` environment. The workflow now promotes pre-1.0 releases to `latest` and publishes verified main canaries to `next`, but requires the publisher permissions and environment setup below. Editing the workflow does not change existing registry tags or bootstrap the CLI.

## Prerequisites

- **Public repository.** npm provenance is only generated for a public repository publishing a public package. `Rika-Labs/akter` is public.
- **GitHub-hosted runner.** Trusted publishing and provenance reject self-hosted runners. The release job runs on `ubuntu-latest`.
- **npm CLI 12.2.0 and Node 26.7.0.** The workflow pins Node and installs npm 12.2.0, which supports both trusted publishing and OIDC-authenticated dist-tag changes. npm 11.5.1's publish support alone is insufficient for automated `latest` promotion.
- **Trusted-publisher permissions.** For both packages, enable **Allow npm publish** and **Allow npm dist-tag** on the GitHub trusted publisher. Dist-tag permission is independent of publish permission and is disabled by default. See npm's [trusted-publishing documentation](https://docs.npmjs.com/trusted-publishers#managing-dist-tags-with-trusted-publishing). No npm token is needed.
- **`npm` environment.** Both tagged releases and main canaries use this environment. Allow the `main` branch and `v*` tags in its deployment policy. Configure required reviewers as the release maintainers, enable “Prevent self-review”, and disallow administrators from bypassing protection. A maintainer approves only after checking the exact verified SHA and, for a tagged release, its version/changelog changes. Reviewers apply to canaries too; publishing on every green main run will wait for their approval. Maintainers must choose and apply these settings; changing this document does not configure them.
- **Tag ruleset.** Add an active repository ruleset targeting tags that match `v*`. Restrict creation to the release maintainers through the ruleset's bypass list, and restrict updates and deletions so a published tag cannot be moved or removed. The maintainer applies this ruleset in GitHub; a package rebuild uses a new version and tag rather than bypassing the update protection.
- **GitHub Release.** The workflow creates or updates the GitHub Release from the matching `CHANGELOG.md` section after publishing; prerelease versions are marked as prereleases.

## Stage and check a release candidate

From a clean checkout of the commit to release:

```sh
bun install --frozen-lockfile
bun run prepare
bun .github/src/pack.ts --out .local/package --cli-out .local/package-cli
SMOKE_RUNTIME=node bun .github/src/release/smoke.ts --package .local/package --cli-package .local/package-cli
SMOKE_RUNTIME=bun bun .github/src/release/smoke.ts --package .local/package --cli-package .local/package-cli
```

`pack.ts` builds and stages the framework and CLI tarballs with `publishConfig` applied and `catalog:` versions resolved, copies `LICENSE` and `NOTICE`, runs `npm pack --dry-run`, and fails when a required file or export target is missing, when sources, tests or the crash fixtures would ship, when a dependency is still `catalog:` or `workspace:`, when the manifest is private or its version is not semantic, or when compiled code imports a package the manifest does not declare. The CLI includes compiled JS and declarations for `@rikalabs/akter-cli/cloud-api`; `@akter/cloud-api` stays private and is not a separate npm package. `smoke.ts` installs both packed tarballs into a clean temporary project, typechecks the framework and cloud-API consumers, checks the cloud API's endpoint and schema behavior, runs the PGlite command, and runs `akter --help`, `akter login --help`, and `akter dev` readiness and inspector checks on Node and Bun. Without package arguments it stages fresh copies first.

## One-time bootstrap

1. Check out the release commit on `main` and stage the tarballs as above: `bun .github/src/pack.ts --out .local/package --cli-out .local/package-cli`, then run both `SMOKE_RUNTIME=node bun .github/src/release/smoke.ts --package .local/package --cli-package .local/package-cli` and `SMOKE_RUNTIME=bun bun .github/src/release/smoke.ts --package .local/package --cli-package .local/package-cli`.
2. `npm login` with the account that owns the `@rikalabs` scope, with 2FA enabled.
3. Publish the validated CLI tarball, not the workspace source package (whose `prepublishOnly` refuses a local publish). The framework's first publish used `cd .local/package && npm publish --access public --tag alpha`. The first `@rikalabs/akter-cli` publish is a one-time maintainer bootstrap: after both runtime smokes pass, run `mkdir -p .local/tarballs && npm pack .local/package-cli --ignore-scripts --pack-destination .local/tarballs`, then run `npm publish .local/tarballs/rikalabs-akter-cli-<version>.tgz --access public --tag alpha` interactively with 2FA, substituting the checked version. These first versions have no provenance. Configure the CLI's trusted publisher only after this publish creates the package.
4. On npmjs.com configure trusted publishing for both packages: GitHub Actions, organization `Rika-Labs`, repository `akter`, workflow filename `release.yml`, environment `npm`, with **Allow npm publish** and **Allow npm dist-tag** enabled. Every field must match exactly. A new publisher must complete its first successful publish within npm's two-day validation window; configure it when ready to release.
5. Optionally, under Publishing access, choose "Require two-factor authentication and disallow tokens", so only the trusted publisher (and interactive 2FA publishes) can release. Revoke any npm automation token created for this package.
6. Use the tag for the bootstrapped release unit once both packages exist and the trusted publishers are ready. The workflow runs its checks, skips each already-published immutable version, and repairs the pre-1.0 `latest` pointers. If `latest` already names a newer version, promotion leaves it unchanged.

## Releasing with the workflow

1. Bump `version` in both `packages/akter/package.json` and `apps/cli/package.json`, add their changelog entries, and land them on `main`. They must match; the release job checks their equality before publishing anything, and the pack check rejects a mismatched release unit.
2. Wait for a successful `Verify` run for that exact commit, then push a tag `v<version>` on it. To rerun an existing tag, select that tag as both the workflow ref and its `tag` input: `gh workflow run release.yml --ref v<version> -f tag=v<version>`. Dispatching from main while checking out an older tag is refused: npm provenance uses the workflow's `GITHUB_SHA` and its OIDC identity, not an arbitrary checkout SHA.
3. After the `npm` environment approval, the job checks out the tag, checks the tag matches the manifest version and the tagged commit is on `main`, and queries the GitHub Actions API for a completed, successful `Verify` (`ci.yml`) run whose `head_sha` is the tagged commit. A missing, red, cancelled, or unfinished run cannot satisfy this gate; an API failure stops the job. It packs and smoke-tests both packages before publishing either, then runs `npm publish --provenance --access public --tag <dist-tag>` for each version not already on npm. After both publishes succeed, pre-1.0 prereleases promote both packages to `latest` with `npm dist-tag add`. npm exchanges the job's OIDC identity for short-lived credentials; no npm secret exists in the repository.
4. After publishing, the `publish` job uploads that version's validated `packages/akter/CHANGELOG.md` section as an artifact. The same job publishes the `@rikalabs/akter-cli` tarball at the framework version. The dependent `github-release` job downloads the notes and creates the GitHub Release. The publishing job has only repository-content and Actions read permissions plus OIDC issuance; only the release-creation job has `contents: write`, and it neither checks out code nor installs dependencies or runs package scripts. Alphas and other prereleases are marked as prereleases. A rerun updates the existing Release's notes without republishing immutable npm versions.

The primary dist-tag is the first prerelease identifier: `0.1.0-alpha.2` publishes to `alpha` and then also advances `latest`. A version without a prerelease publishes to `latest`; after 1.0, a prerelease only changes its channel. `next` is reserved for canaries and never advances `latest`. Build metadata (`+…`) does not change the channel. Confirm the release pointers after the workflow completes:

```sh
npm view @rikalabs/akter dist-tags
npm view @rikalabs/akter-cli dist-tags
```

Check that `alpha` and `latest` both name the released alpha for both packages. Publishing and dist-tag updates are separate registry operations, not an atomic transaction. If the CLI publish or a tag update fails after the framework publishes, fix the authorization or package problem and rerun the same tagged release: already-published versions are skipped, and `latest` promotion retries without replacing an immutable version on npm. Promotion compares semantic versions so a historical rerun cannot move a newer `latest` backwards; a registry lookup failure stops promotion instead of assuming the tag is absent.

## Main canaries

`release.yml` also listens for completed `Verify` runs on `main`. Only a successful `push` run from this repository's `ci.yml` starts publishing; PR runs (including forks), failures, cancellations and manual Verify runs cannot publish a canary. Superseded main runs are skipped when the verified SHA differs from the release run's default-branch SHA. This keeps the checked-out code identical to the commit npm provenance and the GitHub OIDC certificate identify. The job checks out the verified `head_sha`, checks that it is on main and matches `GITHUB_SHA`, and never overrides the signing identity's environment variables. It uses the same GitHub-hosted runner, environment, npm toolchain, pack checks and both runtime smokes as a tagged release. The GitHub Release and release-notes upload are skipped.

For source version `0.1.0-alpha.2`, a canary might be `0.1.0-next.321.1.g123456abcdef`. The run ID and attempt distinguish retries, and the SHA identifies the verified code. Both staged manifests and the CLI's exact framework dependency use this version; the source manifests and changelogs are not changed. To stage one locally:

```sh
bun .github/src/pack.ts --out .local/next --cli-out .local/next-cli --canary 321.1.g123456abcdef
```

Install with `@rikalabs/akter@next` and `@rikalabs/akter-cli@next` to try the channel, but pin the complete same version of both packages in cloud deployments. Canaries are published only to `next`; they never move `alpha` or `latest`. Tagged releases and canaries share workflow concurrency so publishing jobs do not overlap. As with tagged releases, each package must already exist and its trusted publisher must permit publishing.

## Limits

- The workflow cannot publish a package name that does not exist on npm yet; each new package needs the bootstrap above.
- A tag whose version is already on npm runs every check and the smoke test, then skips `npm publish`; pre-1.0 promotion still runs unless `latest` is newer. npm versions are immutable, so a changed build needs a new version, not a retag.
- The OSS launch claim is multi-runner on one host with `Runner.socket` and `Runner.mtls`, verified with three Bun processes sharing a Postgres database. Separate-host and hosting-provider support need their own evidence in the [support matrix](support-matrix.md).
- `@akter/react` and the Python client generator are repo-only and are not published at launch. Check the [CLI reference](../api/06-cli.md) for its current installation status.
