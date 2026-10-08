# Framework conformance

`@akter/conformance` is an unpublished verification workspace, not an application dependency. App developers use `ActorTest`, `checkBatchLaw`, `cleanup`, `sweepContent`, `testDatabase`, and `disposableDatabase` from `@rikalabs/akter/testing`.

The shared cases in `src/conformance.ts` run on PGlite and real Postgres. Fixtures deliberately inspect framework internals. `clusterLayer` provides `ActorCluster`; `simulate` and `simulateCluster` use the ambient test runtime under a reproducible seeded fault schedule. The cluster harness requires a Postgres URL and cannot prove independent-connection behavior on PGlite.

From the repository root:

```sh
bun run test
bun run --cwd tooling/conformance test:pglite
TEST_DATABASE_URL=<dedicated-test-database> bun run --cwd tooling/conformance test:integration:postgres
TEST_DATABASE_URL=<dedicated-test-database> bun run --cwd tooling/conformance test:integration:drills
bun run test:node:conformance
```

`test:integration:drills` requires Docker. Replica cases require `TEST_REPLICA_DATABASE_URL`; absent provider or replica targets are skips, not evidence of support. Project filters such as `--project=postgres:conformance` and `--project=pglite:conformance` select registered shards. CI, nightly properties, and stress runs use the same workspace commands.
