# Releasing

**Responsibility:** publish `@rikalabs/akter` to npm and bootstrap the npm trusted publisher.
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
bun .github/src/pack.ts --out .local/package
bun .github/src/release/smoke.ts --package .local/package
```

`pack.ts` builds the framework, stages the tarball with `publishConfig` applied and `catalog:` versions resolved, copies `LICENSE` and `NOTICE`, runs `npm pack --dry-run`, and fails when a required file or export target is missing, when sources, tests or the crash fixtures would ship, when a dependency is still `catalog:` or `workspace:`, when the manifest is private or its version is not semantic, or when compiled code imports a package the manifest does not declare. `smoke.ts` packs the staged directory, installs the tarball with its exact peer dependencies into a new temporary project, typechecks a consumer against the published declarations, and runs one command on PGlite. Without `--package` it stages a fresh copy first; `bun run pack:smoke` does that.

## One-time bootstrap (Dallen, from a Mac)

1. Check out the release commit on `main` and stage the tarball as above: `bun .github/src/pack.ts --out .local/package`, then `bun .github/src/release/smoke.ts --package .local/package`.
2. `npm login` with the account that owns the `@akter` scope, with 2FA enabled.
3. Publish from the staged directory, not from `packages/akter` (whose `prepublishOnly` refuses a local publish): `cd .local/package && npm publish --access public --tag alpha`. npm asks for the 2FA code. This first version has no provenance.
4. On npmjs.com open `@rikalabs/akter` → Settings → Trusted Publisher, choose GitHub Actions, and enter organization `Rika-Labs`, repository `akter`, workflow filename `release.yml`, environment `npm`. Every field must match exactly.
5. Optionally, under Publishing access, choose "Require two-factor authentication and disallow tokens", so only the trusted publisher (and interactive 2FA publishes) can release. Revoke any npm automation token created for this package.
6. Tag the bootstrapped commit `v0.1.0-alpha.0` so the tag history matches npm. The tag starts `Release`, which runs its checks, stages and smoke-tests the tarball, sees the version already on npm, and skips `npm publish`.

## Releasing with the workflow

1. Bump `version` in `packages/akter/package.json` and add a `CHANGELOG.md` entry; land it on `main`.
2. Wait for a successful `Verify` run for that exact commit, then push a tag `v<version>` on it, or run the `Release` workflow by hand with the existing tag as its `tag` input.
3. After the `npm` environment approval, the job checks out the tag, checks the tag matches the manifest version and the tagged commit is on `main`, and queries the GitHub Actions API for a completed, successful `Verify` (`ci.yml`) run whose `head_sha` is the tagged commit. A missing, red, cancelled, or unfinished run cannot satisfy this gate; an API failure stops the job. The job checks the npm version, stages and checks the tarball, runs the clean-consumer smoke test, and runs `npm publish --provenance --access public --tag <dist-tag>`. npm exchanges the job's GitHub OIDC identity for a short-lived publish credential; no npm secret exists in the repository.
4. After publishing, the `publish` job uploads that version's validated `packages/akter/CHANGELOG.md` section as an artifact. The dependent `github-release` job downloads it and creates the GitHub Release. The publishing job has only repository-content and Actions read permissions plus OIDC issuance; only the release-creation job has `contents: write`, and it neither checks out code nor installs dependencies or runs package scripts. Alphas and other prereleases are marked as prereleases. A rerun updates the existing Release's notes without republishing the immutable npm version.

The dist-tag is the first prerelease identifier: `0.1.0-alpha.1` publishes to `alpha`. A version without a prerelease publishes to `latest`. Trusted publishing cannot move an existing `latest` dist-tag, so until `1.0` the release owner must log in interactively with npm 2FA and move `latest` after each successful alpha publish, substituting the released version:

```sh
npm dist-tag add @rikalabs/akter@0.1.0-alpha.1 latest
npm view @rikalabs/akter dist-tags
```

Check that `alpha` and `latest` both name the released alpha. This deliberately keeps npm credentials out of GitHub Actions; the trusted publisher remains the only automated publishing credential. Build metadata (`+…`) does not change the dist-tag.

## Limits

- The workflow cannot publish a package name that does not exist on npm yet; each new package needs the bootstrap above.
- A tag whose version is already on npm runs every check and the smoke test, then skips `npm publish`; npm versions are immutable, so a changed build needs a new version, not a retag.
- The first alpha supports one runner per database, as the package README says.
