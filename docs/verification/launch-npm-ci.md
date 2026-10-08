# Launch npm and CI verification

Recorded on 2026-10-08 for `release/launch-npm-ci`, based on `origin/main`. This is local candidate evidence, not a registry publication or a completed GitHub Actions run.

## Environment

Linux x64 orb; Bun 1.4.2, Node 26.10.0. The repository was installed with `bun install --frozen-lockfile --ignore-scripts` and patched with `bun run prepare`. The release workflow pins Node 26.7.0 and npm 12.2.0; its CLI dry-run was also checked with npm 12.2.0. actionlint 1.7.12 was downloaded into disposable scratch storage for validation.

## Executed checks

```sh
bun .github/src/pack.ts --out .local/launch-package --cli-out .local/launch-package-cli
SMOKE_RUNTIME=node bun .github/src/release/smoke.ts --package .local/launch-package --cli-package .local/launch-package-cli
SMOKE_RUNTIME=bun bun .github/src/release/smoke.ts --package .local/launch-package --cli-package .local/launch-package-cli
bun --bun node_modules/vitest/vitest.mjs run .github/src
bun run check:static
GOMAXPROCS=1 bunx --bun oxlint --type-aware --deny-warnings --threads 1 .github/src/pack.ts .github/src/policy.ts .github/src/policy.test.ts .github/src/release/smoke.ts .github/src/release/version.ts .github/src/release/version.test.ts
bun run --cwd apps/cli typecheck
actionlint
git diff --check
```

- Both `0.1.0-alpha.2` packages pass the tarball check: 615 framework files and 25 CLI files. The CLI includes the cloud API's bundled JS and complete declaration tree, with the staged `./cloud-api` export pointing to both.
- Both clean-consumer smokes pass: declaration typecheck, memory increments `[2,5]`, file-backed restart `[2,5]` → `[7,10]`, receipt replay and before/after-commit crash injection. CLI help, offline login help, dev readiness, command results `[7,9]`, inspector asset and old-route refusal also pass.
- The cloud subpath typechecks and imports on both engines without running the CLI. It exposes `/api/projects/:projectId`, decodes a branded project ID and role `viewer`, refuses role `operator`, accepts log limit 200 and refuses 201. A negative type assertion rejects `operator` as a `Role`.
- All 8 `.github/src` test files pass, 33 tests total. Release tests distinguish pre-1.0 promotion, post-1.0 prereleases, stable releases and reserved `next`, refuse mismatched versions, and execute the workflow's semantic-version comparison against numeric alpha and stable boundaries so historical reruns cannot regress `latest`. The production provenance-SHA shell gate is exercised with matching and different signing/checkout identities.
- Static checks, focused typed lint, CLI typecheck, formatting, structure and actionlint pass.

## Canary staging

```sh
bun .github/src/pack.ts --out .local/launch-next --cli-out .local/launch-next-cli --canary 321.2.g123456abcdef
SMOKE_RUNTIME=node bun .github/src/release/smoke.ts --package .local/launch-next --cli-package .local/launch-next-cli
SMOKE_RUNTIME=bun bun .github/src/release/smoke.ts --package .local/launch-next --cli-package .local/launch-next-cli
```

Both tarballs and both runtime smokes pass at `0.1.0-next.321.2.g123456abcdef`. Independent manifest assertions confirm both staged versions and the CLI's exact framework dependency equal that value. SHA-256 comparisons before and after packing confirm that both source manifests remain unchanged. `npm publish .local/launch-next-cli --dry-run --ignore-scripts --access public --tag next` succeeds with npm 12.2.0, while warning that real publication requires authentication; it does not verify OIDC permissions.

## External state and remaining proof

Read-only GitHub API inspection found the active main ruleset requires `verify` and `branch`, not `Current SHA evidence`. The `npm` environment had no reviewers or deployment restrictions. Those settings were not changed. The requested release branch is covered by the candidate's narrow `release/<slug>` exception, but the existing trusted policy checks out main and will not see that exception until a separately approved policy rollout.

The workflow's successful-main-push filter, exact-SHA checkout, hosted runner and channel conditions were reviewed and linted; the actual event-to-OIDC flow still requires a real authorized workflow run. npm documents dist-tag OIDC support in npm 12.2.0, with **Allow npm dist-tag** configured independently from **Allow npm publish**. npm's [provenance generation](https://github.com/npm/cli/blob/v12.2.0/workspaces/libnpmpublish/lib/provenance.js) takes the source digest from `GITHUB_SHA`, which GitHub's `workflow_run` defines as the default-branch commit, not the triggering run's head. Superseded verified runs are therefore skipped; overriding `GITHUB_SHA` would not correct the certificate's signing identity. Manual releases dispatch on their exact tag ref. The CLI bootstrap, both trusted publishers' permissions, environment policy and reviewer choices remain maintainer actions. No merge, release tag, registry publish, dist-tag update or deployment was performed for this evidence.
