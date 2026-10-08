# ADR 0111: Framework verification stays outside the published package

**Status:** accepted (2026-10-08).

## Context

The framework's app-testing entry also exported the complete conformance corpus, workflow-engine fixtures, and seeded single-runner and cluster simulations. Those framework-maintainer tools accounted for most of its testing source and increased every npm install. `ActorTest` imported the simulations and cluster directly, so removing barrel exports alone would not remove their compiled files.

## Decision

Move conformance, its foundation fixtures, cluster harness, and simulation modules to the private `@akter/conformance` workspace in `tooling/conformance`. It owns the PGlite, Postgres, Node, and subprocess-drill configurations and shares framework source only for repository verification. Production framework code imports no workspace package.

Keep `@rikalabs/akter/testing` and its app-facing `ActorTest`, cleanup/content sweeps, database fixtures, batch-law checker, and fault controls. Remove `ActorTest.cluster`, `ActorTest.simulate`, and `ActorTest.simulateCluster`; maintainers use `clusterLayer`, `simulate`, and `simulateCluster` from the unpublished workspace. No forwarding imports or compatibility aliases reconnect the published entry to those tools.

This amends the testing-distribution boundary in ADRs 0008, 0011, and 0029, not their runtime guarantees or required failure evidence. CI and nightly verification still execute the same scenarios. Applied database migrations and backend behavior are unchanged.

## Alternatives

Excluding files only at packaging time would leave broken public exports. Keeping only type exports would still expose a framework-maintainer interface without its implementation. Publishing a second test package adds a release unit without an app-developer requirement.

## Consequences and evidence

The alpha testing API narrows intentionally; app tests keep the real database and transaction path. The pack check rejects compiled conformance, foundation, cluster, and simulation files even if a future edit accidentally reconnects them. [Package evidence](../verification/framework-package.md) records packed size and dependency/consumer checks.

Revisit only if application developers need a separately supported conformance or multi-runner testing product. That requires its own public API and release policy, rather than republishing framework fixtures.
