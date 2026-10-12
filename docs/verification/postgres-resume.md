# Postgres suspension recovery evidence

## Real ownership and durable consequences

`multiRunner: withdraws resumed runner readiness until real shard reacquisition and discards its staged stale turn` runs two real Postgres runners with public-runner readiness and three-second table leases. It commits `1`, pauses the owner's `+100` turn before COMMIT, stops its heartbeats, independently observes the rival taking the expired lease, blackholes only the old runner's replies and shifts only its wall clock by 300 seconds. Readiness immediately withdraws, the socket epoch advances exactly once and the rival commits `+10` as `11`, proving the old staged transaction rolled back. Repeated readiness probes stay unready while independent lock rows remain the rival's.

Only after heartbeats resume and the rival gracefully releases its locks can readiness return. The test independently requires all 32 default shard rows to belong to the resumed runner with acquisition times newer than the database-observed recovery boundary. The original pending identity then commits as `111`; a further `+1000` yields `1111`, exactly four receipts and events, four distinct command IDs, cursors `1` through `4`, and a newer generation. The full twelve-case multi-runner shard also retains stale-generation, interruption, replay, restart and cross-runner delivery coverage.

Scratch aliases that remove the epoch readiness gate or replace it with local acquisition belief both fail the new case with `{ready:true}` instead of the required unready answer. A separate canonical-generation baseline passes the existing stale-activation case; removing its generation comparison fails with `101` instead of `111`. That control disables warm speculation in both baseline and mutant because the current warm path has an independent SQL generation guard; removing only the canonical comparison with warm speculation enabled is not a valid negative control.

A separate recovery-side acquisition mutant fails the idle advisory-lock oracle: two locks appear where `pg_locks` must be empty. The production callback does not take them. Cross-epoch operation results still reach Cluster for adoption or release, but cannot populate the new epoch's ownership proof or unchecked-acquisition cache.

## Transport, reserved sessions and steady-state cost

`runtime/database/resume.test.ts` opens actual off-turn, query, replica, coordination and turn sessions, records their backend PIDs, resets their shared epoch and requires every held session to fail within 500 milliseconds. Replacement sessions must use new PIDs. Both supplied and default factories are covered, including URL host/port query parameters overriding a deliberately unusable authority. With `RESUME_TEST_TLS_CA` set, every session must also report `pg_stat_ssl.ssl = true`; the driver receives the fixture CA and `rejectUnauthorized: true` with `sslmode=verify-full`.

The reserved-lock case first acquires two advisory locks through `SqlRunnerStorage`. After resetting the epoch it leaves the registered storage idle for 1.2 seconds: `pg_locks` must stay empty and readiness must stay withdrawn, rejecting a recovery callback that creates locks without Cluster bookkeeping. It then starts real `Sharding`, which alone acquires the new locks through the production recovery decorator. The epoch cannot reopen until `pg_locks` independently shows those exact lock numbers held together by a different backend, after which a real refresh must return both shards. The fixture uses a three-second lease and 250-millisecond entity/assignment polls; production polling and heartbeat settings remain unchanged. This covers the lifetime reservation separately from table-backed two-runner fencing, not an end-to-end default-cadence latency bound.

With `RESUME_TEST_STATEMENTS=1` on a local server preloading `pg_stat_statements`, the isolated-database oracle measures exactly 21 additional executions for twenty warm SQL requests and the counter query itself. No socket factory calls or epoch changes occur during those requests. Without that flag, the portable integration test still checks pool continuity but makes no server statement-count claim. The local plaintext and verified-TLS runs enabled the independent counter.

The existing fifteen warm-path/pipeline cases pass unchanged on Bun and Node, retaining their exact flight/statement counts, speculative SQL fencing, lost-COMMIT receipt resolution and expiry-after-fence checks. HTTP served-clock fault injection now replaces only the served estimator's clock-pair source, leaving the runtime detector untouched; all original committed-response, request-ID, CORS and identity assertions pass. Full-runtime socket recovery is established by the separate two-runner scenario, not by those estimator fixtures.

`runtime/clock.test.ts` separately rejects publishing readiness before destruction, satisfying an old close barrier while a newer epoch is closing, repeated resets from the same correction and missing idle detection on the one-second clock-only tick. Those tests use controlled public Duplex close callbacks, not a simulated Postgres authority.

## Local reproduction

Run the repository's integration command against a disposable authenticated Postgres server. The focused commands are:

```sh
TEST_DATABASE_URL=... bun run --cwd tooling/conformance test:integration:postgres --project postgres:multi-runner
TEST_DATABASE_URL=... RESUME_TEST_STATEMENTS=1 bun --bun node_modules/vitest/vitest.mjs run packages/akter/src/runtime/database/resume.test.ts
TEST_DATABASE_URL=... RESUME_TEST_STATEMENTS=1 RESUME_TEST_TLS_CA=/path/to/local-ca.crt node node_modules/vitest/vitest.mjs run packages/akter/src/runtime/database/resume.test.ts
```

The local Bun and Node transport runs use real SCRAM-authenticated Postgres and verified loopback TLS. These are runtime and storage guarantees, not Fly, PlanetScale, transaction-pooler or separate-host certification. The clock-correction residual window and original silent-peer-loss cause remain unknown.
