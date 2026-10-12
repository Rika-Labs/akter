# Postgres suspension recovery evidence

## Real ownership and durable consequences

`multiRunner: withdraws resumed runner readiness until real shard reacquisition and discards its staged stale turn` runs two real Postgres runners with public-runner readiness and three-second table leases. It commits `1`, pauses the owner's `+100` turn before COMMIT, stops its heartbeats, independently observes the rival taking the expired lease, blackholes only the old runner's replies, terminates that runner's independently identified backend sessions, and shifts only its wall clock by 300 seconds. Readiness waits for the bounded fresh verification, then remains withdrawn; the socket epoch advances exactly once and the rival commits `+10` as `11`, proving the old staged transaction rolled back. Repeated readiness probes stay unready while independent lock rows remain the rival's.

Only after heartbeats resume and the rival gracefully releases its locks can readiness return. The test independently requires all 32 default shard rows to belong to the resumed runner with acquisition times newer than the database-observed recovery boundary. The original pending identity then commits as `111`; a further `+1000` yields `1111`, exactly four receipts and events, four distinct command IDs, cursors `1` through `4`, and a newer generation. The full twelve-case multi-runner shard also retains stale-generation, interruption, replay, restart and cross-runner delivery coverage.

Scratch aliases that remove the epoch readiness gate or replace it with local acquisition belief both fail the new case with `{ready:true}` instead of the required unready answer. A separate canonical-generation baseline passes the existing stale-activation case; removing its generation comparison fails with `101` instead of `111`. That control disables warm speculation in both baseline and mutant because the current warm path has an independent SQL generation guard; removing only the canonical comparison with warm speculation enabled is not a valid negative control.

A separate recovery-side acquisition mutant fails the idle advisory-lock oracle: two locks appear where `pg_locks` must be empty. The production callback does not take them. Cross-epoch operation results still reach Cluster for adoption or release, but cannot populate the new epoch's ownership proof or unchecked-acquisition cache.

## Transport, reserved sessions and steady-state cost

`runtime/database/resume.test.ts` opens actual off-turn, query, replica, coordination and turn sessions and records their backend PIDs. A 300-second wall-clock shift with every backend surviving must retain every original socket and epoch, publish ready within 500 milliseconds, and invoke no reacquisition callback. After independently terminating those PIDs, another shift must reset the epoch and make every held session fail within 500 milliseconds. Replacement sessions must use new PIDs. A further correction during incomplete recovery must retain the replacements without trusting dead, old-scope PID observations. Both supplied and default factories are covered, including URL host/port query parameters overriding a deliberately unusable authority. With `RESUME_TEST_TLS_CA` set, every session must also report `pg_stat_ssl.ssl = true`; the driver receives the fixture CA and `rejectUnauthorized: true` with `sslmode=verify-full`.

The reserved-lock case first acquires two advisory locks through `SqlRunnerStorage`. With those sessions alive and the registration artificially aged by 300 seconds, verification must retain the exact lock/PID rows and restore its heartbeat without changing the socket epoch. After terminating the lock backend and resetting the epoch, it leaves the registered storage idle for 1.2 seconds: `pg_locks` must stay empty and readiness must stay withdrawn, rejecting a recovery callback that creates locks without Cluster bookkeeping. It then starts real `Sharding`, which alone acquires the new locks through the production recovery decorator. The epoch cannot reopen until `pg_locks` independently shows those exact lock numbers held together by a different backend, after which a real refresh must return both shards. The fixture uses a three-second lease and 250-millisecond entity/assignment polls; framework defaults remain unchanged.

The table-lock case retains sockets, exact lease rows and epoch after a correction with valid leases and an old heartbeat. It independently expires just one of two leases beyond the configured seven-second expiration; another correction must reset even though all sessions survived, without acquiring either lease from the verifier. The concurrent-blackhole case opens two differently named endpoint groups, blocks only new verifier replies, and requires both groups to settle in 1.4–2.0 seconds rather than two sequential deadlines. Existing sockets must remain intact during the first 100 milliseconds and be destroyed only after failed verification.

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

## Conditional path latency and operator cadence

Measurements on the conditional revision use a separate Bun runner process, real authenticated PostgreSQL 17.11 with verified TLS, `Actors.layer()`, and the actual low-connection preset: one turn, two off-turn and one query connection. The exact embedded/hosted topology is one runner and one advisory-locked shard. A physical `SIGSTOP` freezes the process while the controller ages its registration by 300 seconds, optionally terminates all precisely named backends, and changes only the wall-clock reading supplied through `ClockReadings`. Ten samples per path vary native timer phase from 0 to 6,750 milliseconds. Detection-to-ready starts at the first corrected clock reading, not at provider wake or the controller's request. Percentiles use nearest rank. Independent `pg_stat_activity` rows must keep all PIDs on survival; `pg_locks` must show the actual shard after recovery.

| Configuration                           | Sessions   |   n | Detection-to-ready p50 |      Max |
| --------------------------------------- | ---------- | --: | ---------------------: | -------: |
| Framework default cadence               | Survived   |  10 |               15.81 ms | 31.92 ms |
| Framework default cadence               | Terminated |  10 |               14.029 s | 17.806 s |
| Opt-in 1 s refresh / 500 ms entity poll | Survived   |  10 |               12.31 ms | 15.07 ms |
| Opt-in 1 s refresh / 500 ms entity poll | Terminated |  10 |                0.860 s |  1.369 s |

The default samples physically pause for 2.1 seconds after metadata aging. The opt-in samples pause for 50 milliseconds to avoid advancing native timers enough to make recovery appear artificially fast. Neither simulates every effect of a physical 300-second suspension; these are local detection-to-ready measurements, not Fly wake results or evidence that production sessions commonly survive.

The operator candidate supplies only the two public `ShardingConfig` cadence fields to the otherwise unchanged embedded topology. Assignment refresh stays at 3 seconds and lock expiration at 35 seconds. It is not installed in the hosted entrypoint by this framework change and needs a separate operator decision.

An isolated `pg_stat_statements` comparison over approximately 20 seconds of an awake idle runner records 35 statements / 20.057 seconds at defaults (1.745/s), and 71 / 20.018 seconds at the candidate cadence (3.547/s): approximately **+1.80 statements/s per awake runner**. Lock inspection and runner-heartbeat updates each rise from 2 to 20 executions; assignment reads stay at 7, and outbox polls stay at 20. No additional idle message SQL appears in this workload; active registrations/workloads may differ. A suspended process executes no recurring queries. The conditional verifier adds one combined SQL execution per endpoint per detected correction, not a warm-query probe.

Default dead-session recovery still follows native Cluster timers. A complete public Layer rebuild was assessed but not implemented: it would require forwarding service generations, replaying registrations, rebuilding cached clients/handlers, and managing old shutdown. A minimal upstream public acquisition wake trigger could remove the recurring cadence cost while preserving native lock adoption/release; no such API or dependency patch is assumed here.

The direct-session proof depends on own-session visibility in `pg_stat_activity`, exact application identity and matching public BackendKeyData/SQL PIDs. Ambiguous shared names, unsupported pooler identities, permissions, connection errors and timeout fall back to reset. PlanetScale documents distinguish direct session endpoints from transaction pooling, but documentation and connection UI do not establish this revision's actual runtime compatibility; provider verification remains required.
