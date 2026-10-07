# ADR 0098: Akter Cloud lives in a private proprietary repository

**Status:** accepted (2026-10-06), decided by Dallen.

**Responsibility:** separate the public framework and client interfaces from the hosted platform's implementation and assets.

**Authority:** recorded decision.

**Owner role:** repository architecture.

**Supersedes:** ADR 0074 item 1 and ADR 0029's `apps/*` licensing clause. The framework, public CLI and public cloud API contract remain Apache-2.0.

## Context

The public repository currently includes the hosted control plane, deployment infrastructure, product UI, research archive and commercial font files. Keeping those together makes the framework's distribution depend on private platform concerns. The hosted product needs its own repository and release pipeline while continuing to build against the public framework's exact source and shared tooling.

## Decision

1. `Rika-Labs/akter` stays public. Its history is not rewritten. Removing cloud code and commercial assets from the current tree does not revoke any license previously granted or erase them from history.
2. Akter Cloud is proprietary and lives in the private `Rika-Labs/akter-cloud` repository. Its license notice is Copyright Rika Labs, all rights reserved. The Apache-2.0 license continues to apply to the public framework and other public code.
3. The private repository mounts the public repository as the `akter/` git submodule, pinned to a reviewed public commit. Its Bun workspaces consume framework packages and shared lint, format and structure tooling from that submodule. Shared catalog entries must match the pinned public catalog; submodule updates refresh the private lockfile in a pull request.
4. The public tree keeps `packages/akter`, `packages/react`, `packages/python-client`, `packages/cloud-api`, `apps/cli`, tooling and framework documentation. The CLI keeps `login`, `logout`, `whoami` and `deploy`; billing catalog setup and tenant-directory creation move to the private Effect CLI in `apps/ops`. Their tests move with them, and hosted stack integration tests remain private.
5. Hosted apps, billing, metering, deployment, database, feature-flag and UI packages, infrastructure, research and `plan.md` move private. Cloud-only docs and decisions move with their implementation. A decision that defines framework behavior remains public even when the cloud motivated it, including assertions, runtime routing, mutual TLS, telemetry and authority placement.
6. PolySans and Sagittaire are commercial assets and are removed from the public tree. Public docs load PolySans from the marketing site's stable HTTPS URL with CORS for font requests; the OFL Geist Mono asset can remain public. The private proprietary notice grants no additional font rights.
7. Public CI and releases verify only public code. The private repository has cloud-only CI, deploys and an hourly/manual submodule-update workflow. The GitHub environments stack targets the private repository. Moving workflow files does not authorize provisioning environments, enabling Actions or a production cutover without the orchestrator's coordinated review.

## Consequences

The framework can install, build and verify without cloud source or credentials. Cloud changes use private pull requests and do not rely on public issue numbers, secrets or deployment environments. Cloud-only decision records are identified as private in public prose rather than linked to an inaccessible repository. Changes that span both repositories ship the public interface first, then bump the private submodule and verify the platform against that exact commit.

## Verification

The split's pull requests record frozen installs, focused CLI and tooling tests, public CI, cloud CI, the copied test locations and a check for cloud changes after the copy point. Actions and production GitHub environments are cut over by the orchestrator only after those results are reviewed.
