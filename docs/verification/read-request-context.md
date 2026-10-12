# Read-phase request identity

`packages/akter/src/actor/reads.test.ts` rejects a query, watch or stream handler that observes its layer-builder's ambient caller or tenant while `X.Read` exposes the authenticated request. It constructs the layer under a deliberately different user and tenant, then uses asymmetric users and tenants with the same actor id. The ordinary query and watch paths are tested separately because only the ordinary path restores the handler layer's services.

The regressions were reproduced before the fix: ordinary queries and watch reads returned the layer-builder identity; the stream case still returned that identity after an initial query-only fix. Binding the request identity into the provided handler context makes those references override captured services rather than be overwritten by them. `X.Read` and external authorization were already correctly scoped; this change does not add a query capability or certify application raw SQL predicates.

The public HTTP reproduction used published alpha.6, Bun 1.4.2 and real local Postgres 18.6. A query for authenticated tenant `a`, caller `alice`, observed ambient tenant `default` and caller `Anonymous`, while `X.Read` correctly reported tenant `a` and caller `alice`. No production customer data exposure was demonstrated. The focused regression uses the real framework runtime with PGlite because the fault is Effect context propagation, not database locking or fencing.

On 2026-10-12, all three corrected identity cases also passed against a dedicated real Postgres 18.6 database using `QUERY_CONTEXT_TEST_DATABASE_URL`. The new cases failed before the relevant fixes; the focused PGlite regression and nearby layer/turn suites passed 12 tests after the fix. Package typecheck passed. These are local runtime results, not evidence that a released or hosted deployment already contains the correction.

Run the focused regression and nearby layer/turn checks from the root:

```sh
bun --bun node_modules/vitest/vitest.mjs run packages/akter/src/actor/reads.test.ts packages/akter/src/actor/layers.test.ts packages/akter/src/actor/turns.test.ts
bun run --cwd packages/akter typecheck
QUERY_CONTEXT_TEST_DATABASE_URL=<dedicated-postgres> bun --bun node_modules/vitest/vitest.mjs run packages/akter/src/actor/reads.test.ts
```
