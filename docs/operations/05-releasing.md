# Releasing

**Responsibility:** publish `@rikalabs/akter` and `@rikalabs/akter-cli` to npm and bootstrap the npm trusted publishers.
**Authority:** operational.
**Owner role:** API and release.
**Change policy:** a change requires operator review when a procedure or limit changes.

## Status

`0.1.0-alpha.0` was published by hand on 2026-10-04 and tagged `v0.1.0-alpha.0`; the npm trusted publisher for `Rika-Labs/akter`'s `release.yml` in the `npm` environment is configured. Every later version publishes from `.github/workflows/release.yml` without an npm token.

## Prerequisites

- **Public repository.** npm provenance is only generated for a public repository publishing a public package. `Rika-Labs/akter` is public.
- **GitHub-hosted runner.** Trusted publishing and provenance reject self-hosted runners. The release job runs on `ubuntu-latest`.
- **npm CLI 11.5.1 or later and Node 22.14.0 or later.** The workflow pins Node 26.7.0 and fails before publishing when its bundled npm is older than 11.5.1.
- **`npm` environment.** The release job runs in the GitHub `npm` environment. The trusted publisher names that environment, so a run outside it cannot publish. Configure required reviewers as the release maintainers, enable “Prevent self-review”, and disallow administrators from bypassing protection. Restrict deployment branches and tags to the `v*` tag pattern. A release maintainer other than the initiator approves the job only after checking the tagged commit's successful Verify run and version/changelog changes. These repository settings are applied by the maintainer; changing this document does not configure them.
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

`pack.ts` builds and stages the framework and CLI tarballs with `publishConfig` applied and `catalog:` versions resolved, copies `LICENSE` and `NOTICE`, runs `npm pack --dry-run`, and fails when a required file or export target is missing, when sources, tests or the crash fixtures would ship, when a dependency is still `catalog:` or `workspace:`, when the manifest is private or its version is not semantic, or when compiled code imports a package the manifest does not declare. `smoke.ts` packs both staged directories, installs them with their exact dependencies into a new temporary project, typechecks a framework consumer, runs its PGlite command, and runs `akter --help`, `akter login --help`, and `akter dev` readiness and inspector checks on Node and Bun. Without package arguments it stages fresh copies first.

## One-time bootstrap (Dallen, from a Mac)

1. Check out the release commit on `main` and stage the tarballs as above: `bun .github/src/pack.ts --out .local/package --cli-out .local/package-cli`, then run both `SMOKE_RUNTIME=node bun .github/src/release/smoke.ts --package .local/package --cli-package .local/package-cli` and `SMOKE_RUNTIME=bun bun .github/src/release/smoke.ts --package .local/package --cli-package .local/package-cli`.
2. `npm login` with the account that owns the `@rikalabs` scope, with 2FA enabled.
3. Publish the validated CLI tarball, not the workspace source package (whose `prepublishOnly` refuses a local publish). The framework's first publish used `cd .local/package && npm publish --access public --tag alpha`. The first `@rikalabs/akter-cli` publish is a one-time maintainer bootstrap: after both runtime smokes pass, run `mkdir -p .local/tarballs && npm pack .local/package-cli --ignore-scripts --pack-destination .local/tarballs`, then run `npm publish .local/tarballs/rikalabs-akter-cli-<version>.tgz --access public --tag alpha` interactively with 2FA, substituting the checked version. These first versions have no provenance. Configure the CLI's trusted publisher only after this publish creates the package.
4. On npmjs.com configure trusted publishing for `@rikalabs/akter` and `@rikalabs/akter-cli`: choose GitHub Actions, and enter organization `Rika-Labs`, repository `akter`, workflow filename `release.yml`, environment `npm`. Every field must match exactly.
5. Optionally, under Publishing access, choose "Require two-factor authentication and disallow tokens", so only the trusted publisher (and interactive 2FA publishes) can release. Revoke any npm automation token created for this package.
6. Tag the bootstrapped commit `v0.1.0-alpha.0` so the tag history matches npm. The tag starts `Release`, which runs its checks, stages and smoke-tests the tarball, sees the version already on npm, and skips `npm publish`.

## Releasing with the workflow

1. Bump `version` in both `packages/akter/package.json` and `apps/cli/package.json`, add their changelog entries, and land them on `main`. They must match; the release job checks their equality before publishing anything, and the pack check rejects a mismatched release unit.
2. Wait for a successful `Verify` run for that exact commit, then push a tag `v<version>` on it, or run the `Release` workflow by hand with the existing tag as its `tag` input.
3. After the `npm` environment approval, the job checks out the tag, checks the tag matches the manifest version and the tagged commit is on `main`, and queries the GitHub Actions API for a completed, successful `Verify` (`ci.yml`) run whose `head_sha` is the tagged commit. A missing, red, cancelled, or unfinished run cannot satisfy this gate; an API failure stops the job. The job checks the npm version, stages and checks the tarball, runs the clean-consumer smoke test, and runs `npm publish --provenance --access public --tag <dist-tag>`. npm exchanges the job's GitHub OIDC identity for a short-lived publish credential; no npm secret exists in the repository.
4. After publishing, the `publish` job uploads that version's validated `packages/akter/CHANGELOG.md` section as an artifact. The same job publishes the `@rikalabs/akter-cli` tarball at the framework version. The dependent `github-release` job downloads the notes and creates the GitHub Release. The publishing job has only repository-content and Actions read permissions plus OIDC issuance; only the release-creation job has `contents: write`, and it neither checks out code nor installs dependencies or runs package scripts. Alphas and other prereleases are marked as prereleases. A rerun updates the existing Release's notes without republishing immutable npm versions.

The dist-tag is the first prerelease identifier: `0.1.0-alpha.1` publishes to `alpha`. A version without a prerelease publishes to `latest`. Trusted publishing cannot move an existing `latest` dist-tag, so until `1.0` the release owner must log in interactively with npm 2FA and move `latest` after each successful alpha publish, substituting the released version:

```sh
npm dist-tag add @rikalabs/akter@0.1.0-alpha.1 latest
npm dist-tag add @rikalabs/akter-cli@0.1.0-alpha.1 latest
npm view @rikalabs/akter dist-tags
npm view @rikalabs/akter-cli dist-tags
```

Check that `alpha` and `latest` both name the released alpha. This deliberately keeps npm credentials out of GitHub Actions; the trusted publisher remains the only automated publishing credential. Build metadata (`+…`) does not change the dist-tag.

## Limits

- The workflow cannot publish a package name that does not exist on npm yet; each new package needs the bootstrap above.
- A tag whose version is already on npm runs every check and the smoke test, then skips `npm publish`; npm versions are immutable, so a changed build needs a new version, not a retag.
- The first alpha supports one runner per database, as the package README says.
