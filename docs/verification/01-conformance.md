# Conformance

**Responsibility:** ensure every backend and transport obeys the same contracts.  
**Authority:** evidence.  
**Owner role:** verification.
**Change policy:** a change requires the conformance suite to be updated in the same change.

`durable-actors/testing` exports `ActorTest`, `conformance`, and `describeConformance`. The same named cases MUST run against PGlite, real Postgres, and Neki. PGlite is valid for fast/unit coverage; lock contention and true concurrent connection behavior MUST run on real Postgres. A backend is supported only when its applicable cases pass.

## Foundation evidence

The shared harness now exists: `conformance` is the named case list and `describeConformance` registers it against a `ConformanceBackend` through an injected registrar, so no test framework is imported by the suite itself. Backends that cannot open a second SQL connection set `independentConnections: false` and report those cases through `registrar.skip` — by name, never silently. PGlite runs [`pglite.test.ts`](../../packages/durable-actors/src/runtime/database/pglite.test.ts); Postgres runs [`conformance.test.ts`](../../packages/durable-actors/src/testing/conformance.test.ts) and the SIGKILL suite [`crash/main.test.ts`](../../packages/durable-actors/src/testing/conformance/crash/main.test.ts).

**Executed 2026-09-22:** Bun 1.4.2, Effect/SQL 4.0.0-rc.116, PGlite 0.5.8, and disposable Postgres 18.6. `bun run check` passed all 52 tasks, including 40 framework tests (30 shared PGlite cases, four PGlite lifecycle/migration/creation-policy cases, six declaration/identity tests); five independent-connection cases were explicitly skipped on PGlite. `bun run test:integration` passed 38 Postgres framework tests (35 named conformance cases, migration rollback, and two real SIGKILL recoveries), plus the runnable counter example. The [PR](https://github.com/Rika-Labs/durable-actors/pull/7) records the exact pushed revision and CI evidence artifact; local results do not substitute for that artifact.

### Shared cases (PGlite and Postgres)

- `resolves all identity modes without writes and receipts stateless commands`
- `gates creation, rolls back failed creation, and replays its error receipt`
- `keeps creation marker and receipt atomic across beforeCommit crash`
- `keeps creation marker and receipt atomic across afterCommit crash`
- `retains creation and singleton receipt identity across runtime restart`
- `enforces UTF-8 state bytes and invokes read-only defect hooks after rollback`
- `bounds failing defect hooks and preserves the original defect`
- `hides internal commands and binds System principal and receipt access`
- `redelivers the same command after execution timeout without a partial commit`
- `redelivers the same command after retryable SQL defect without a partial commit`
- `delivery timeout stops waiting while the admitted command commits once`
- `commits state and receipt, replays an identical command effect, and keeps its generation`
- `rolls back declared failures and replays their class and payload without executing again`
- `deduplicates concurrent deliveries and rejects changed input or command`
- `captures callers, preserves same-subject access, and never partitions deduplication by caller`
- `recovers beforeHandler crashes with the same command and one committed transition`
- `recovers beforeCommit crashes with the same command and one committed transition`
- `recovers afterCommit crashes with the same command and one committed transition`
- `does not cancel an accepted turn with its waiter`
- `rejects a stale generation before rerunning the handler under new authority`
- `rolls back captured request/reply misuse and rejects escaped state capabilities`
- `refuses to reinterpret retained identities under a changed retry window`
- `revokes external access without canceling persisted work or trusted redelivery`
- `defines exact expiry boundaries and rejects invalid/future identities`
- `canonicalizes object keys but preserves array order in payload hashes`
- `recovers a declared failure beforeCommit without persisting dirty state`
- `recovers a declared failure afterCommit without persisting dirty state`
- `completes trusted redelivery after expiry but refuses the external outcome`
- `rejects an expired identity after receipt pruning and runtime restart`
- `isolates durable state between fresh layer builds`

### Postgres-only cases (independent connections)

These require a real second connection and are reported skipped on PGlite:

- `keeps uncommitted state invisible to a second connection`
- `rejects a state setter from another still-active actor turn`
- `denies a competing caller while the original failure is still uncommitted`
- `decodes regclass so the migrator can reopen the database` — exercises the scoped rc.116 codec workaround for [Effect #8309](https://github.com/Effect-TS/effect/pull/8309)
- `retries a real generation lock timeout without entering the handler` — real Postgres `FOR UPDATE`; observes two distinct blocked attempts while the competing transaction still holds the lock, then one committed transition

### Backend-specific cases

- PGlite, in `pglite.test.ts`: `owns a fresh database per layer build and closes both instances` and `leaves a borrowed client open and does not replace its query method` — isolate builds and verify owned versus borrowed resource lifetimes.
- PGlite, in `pglite.test.ts`: `rolls back partial foundation DDL and safely reruns the migration` — a deliberate `actor_state` collision proves rollback without a recorded migration, then rerun succeeds.
- PGlite, in `pglite.test.ts`: `does not treat a pre-policy successful command as creation after restart` — reuses a borrowed database across runtime builds and requires a successful creating command after adopting `Lifecycle.createdBy`.
- Postgres, in `crash/main.test.ts`: `rolls back partial foundation DDL and safely reruns the migration`, plus `recovers SIGKILL beforeCommit from persisted Cluster storage without a new call` and `recovers SIGKILL afterCommit from persisted Cluster storage without a new call` — a child process is killed at a signaled barrier, durable rows are inspected with a separate pool, and a fresh process completes the persisted message with one receipt/state transition.

The runnable [counter's own test](../../examples/counter/src/counter/layer.test.ts) uses its actual contract/handler through both commit fault points, rather than relying only on a framework fixture.

Run `bun run --filter durable-actors test` for declaration, identity, and the PGlite suite; run `TEST_DATABASE_URL=<disposable-admin-url> bun run --filter durable-actors test:integration` and `TEST_DATABASE_URL=<disposable-admin-url> bun run --filter @durable-actors/counter test:integration` for Postgres and crash coverage. The role must create/drop temporary databases; tests never use application data. The existing CI `check:ci` task runs these and records the tested revision in `evidence/sha.txt`, logs in `evidence/check.log`, and the `evidence-<head-sha>` artifact. The PR links its actual current-revision run; this ledger is a map to tests, not a replacement for that artifact.

This completes M0 evidence, not full backend certification. Unimplemented gates below remain required for their later milestones, including multi-runner ownership, singleton failover/run/cron, state migrations, cleanup/restore, bounded drain, and provider behavior.

## Faithful test boundary

`ActorTest` MUST exercise the real turn, Cluster entity, SQL tables, serialization, receipts, and outbox. There is no handler-only fake-context runtime. Only the database, transport, clock, executor implementations, and caller are substituted. Use production `SqlMessageStorage` on the test transaction connection, not in-memory message storage whose writes could survive a rolled-back turn. On PGlite, Cluster runner bookkeeping additionally moves to memory because `SqlRunnerStorage` would reserve the sole connection; message storage, migrations, and receipts stay in SQL and this substitution is only valid under `SingleRunner`.

`ActorTest.layer({ database?, as?, authorize?, retryWindowMs? })` supplies the test environment; `runners`, `effects`, old-state seeding helpers, and executor controls remain target API. Each layer build owns a fresh tenant; tests use distinct actor IDs or explicitly reset that tenant. `database` defaults to a fresh in-memory PGlite instance, honors `dataDir` for disk persistence across builds, and accepts a `Redacted` Postgres URL. Bound actor inspection reads committed state without waking an activation. `test.actor(X, id?)` returns a `system` handle that drives every command — including internal ones — with a `System` caller inheriting the configured principal.

Fault controls cover crash hooks, pause/release, redelivery, stale generations, and Postgres lock contention. `TurnHooks` is a testing-only export; `TurnReport` remains planned. In-process multi-runner tests must simulate serialization and give each runner its own message-storage wrapper; they do not substitute for real multi-process Postgres fencing evidence. Effect `TestClock` can control eligible delays; the current harness uses real timers and real SQL locks.

## Design verification gates

The ledger records 17 gate rows below. The foundation evidence above exercises the crash-point, runtime-turn-boundary, and PGlite/PGlite-under-Bun subsets; it does not satisfy gates for members or backends that are not implemented. Other active gates remain **unverified**. The earlier Neki cross-shard alternative is retained for traceability but superseded by the mandatory relay decision in [ADR 0002](../decisions/0002-v4-contract-clarifications.md).

| Gate                               | Required evidence                                                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Neki cross-shard-group transaction | Superseded alternative: the accepted design uses tenant-local `actor_outbox` and the Neki intent relay gate; direct cross-shard writes need a new ADR.                                          |
| Neki locking and pinning           | Generation `FOR UPDATE`, single transaction mode, pinned connection, advisory-lock-disabled pool behavior.                                                                                      |
| Railway advertise address          | Replicas reach each advertised private runner address.                                                                                                                                          |
| PGlite in tests                    | Framework and message-storage DDL/migrations run; contention cases route to Postgres.                                                                                                           |
| Cluster header size                | Largest supported principal fits envelope headers.                                                                                                                                              |
| PGlite under Bun                   | Fresh per-layer databases and migrations run under Bun.                                                                                                                                         |
| In-process multi-runner            | N runners, expiring per-address locks, runner kill, and shard movement after `shardLockExpiration`.                                                                                             |
| Crash points                       | Before-handler, before-COMMIT, after-COMMIT, and runner death prove rollback/redelivery/receipt replay.                                                                                         |
| Intent rollback                    | An intent from a before-COMMIT failure is never delivered.                                                                                                                                      |
| Workflow tenant isolation          | Equal keys in two tenants produce distinct executions; resume restores tenant and `onBehalfOf`.                                                                                                 |
| `waitFor` registration             | Owner event in the start/registration race still resolves the wait.                                                                                                                             |
| Per-call caller over HTTP          | Different bearer tokens produce different principals; absent credentials are Unauthorized, not Anonymous.                                                                                       |
| Turn boundary at runtime           | A captured handle called in a turn dies with `Request/reply inside a turn` and rolls back.                                                                                                      |
| Neki intent relay                  | Crash before/after destination insert and source acknowledgment; retries preserve one logical destination intent and retained receiver outcome.                                                 |
| State migration chain              | Seeded old state upcasts and commits current state; invalid chains fail at `Actor.make`.                                                                                                        |
| Connection park                    | Activation hibernates with sockets open; frame restores state/resumed; broadcast wakes.                                                                                                         |
| Singleton uniqueness               | Two runners produce one logical cron tick and one `run` owner; runner kill moves residency after safe acquisition. Record expiry and resume times separately against the gated recovery target. |

Each gate MUST link to executable cases or an explicit unsupported result. See [failure matrix](02-failure-matrix.md) and [invariants](invariants.md).

Evidence MUST record the revision, test name and command, backend/runtime versions, fault point, durable result, and outcome. A skipped provider test is not a pass, and a typechecked research sketch is not runtime conformance. CI provisions Postgres and executes the current framework tests.

## Implementation decision checks

[ADR 0003](../decisions/0003-failure-scoping-drain-and-hosted-trust.md), [ADR 0004](../decisions/0004-receipt-access-revocation-and-expiry.md), [ADR 0005](../decisions/0005-turn-latency-batching-and-regional-placement.md), and [ADR 0006](../decisions/0006-scale-rules-placement-and-query-tiers.md) add the following requirements without renumbering the historical v4 gate ledger. The foundation tests cover only the explicitly listed state/receipt cases above; the remaining requirements still gate their corresponding feature or adapter.

- **Declared-failure rollback:** write state, migrated state, rows, blobs, events, timers, intents, effects, and staged notifications, then return a declared failure. Assert unchanged business data, no delivery/publication, and one terminal error receipt. Crash before its commit and after commit/before reply; assert respectively redelivery with no receipt and replay without rerunning. Verify caught-error success and explicit rejection output separately. Check that a retained failure still replays after business conditions change.
- **Automatic adapter scoping:** run identical business-only operations across two tenants with equal actor ids and two actors in one tenant with equal business keys. Interleave their operations; verify scoped reads, inserts, updates, deletes, and upserts without application ownership predicates. Reject supplied ownership overrides, unsupported/raw writes, missing scope, off-turn mutation, and escaped transaction-bound capabilities. A later failure must roll back adapter writes with the turn, proving that no second transaction or pool committed independently. Repeat for every claimed query-client/backend combination.
- **Bounded graceful drain:** exercise clean completion and deadline expiry. Verify unready/new-work rejection, no additional claims, rollback of interrupted turns, retained pending work, safe takeover, receipt replay after reply loss, and explicit forced-drain reporting. Preserve ambiguous provider outcomes. Do not equate one drained runner with deployment-wide restore quiescence.
- **Hosted assertions and operator authority:** reject forged signatures, untrusted issuers/keys or algorithms, expired assertions, wrong deployment audiences, and changed actor/operation/command-id/payload bindings before admission. Verify caller isolation, resource authorization, key rotation/revocation behavior, and absence of credentials/assertions in durable rows or telemetry. Admission followed by assertion expiry must not cancel durable execution. Application credentials cannot invoke operator repair; authorized repair is scoped and audited, without bypassing provider reconciliation.
- **Receipt access without re-execution:** commit both successful and declared-failure outcomes for caller A. A rotated credential for A with current access must replay them; caller B with access to the same actor and the same command id must receive neither outcome nor a second execution. Race A/B duplicates on real Postgres, test an unrelated tenant with equal ids, and verify revoked A is denied. An operator succeeds only with receipt-scoped authority. Specify and test System/on-behalf-of and anonymous identity behavior rather than assuming distinguishable anonymous callers.
- **Revocation after durable admission:** revoke before admission and assert no new obligation. Separately revoke after admission but before execution, crash, and resume; accepted turns, intents, and workflows must retain attribution and continue unless explicitly canceled or stopped by application reauthorization. New external calls and receipt reads remain denied. Revocation of live and parked sessions stops access within the documented bound across resumption/reconnect; external requests cannot forge internal recovery authority. Cancellation never claims to undo completed provider effects.
- **Finite retry horizon and safe cleanup:** test first delivery and retries just before, at, and after the specified expiry boundary, including after pruning and restart. Unexpired authorized retries replay; expired external identities produce the specified terminal rejection with no new handler execution or consequences. Race cleanup and retries on real Postgres, interrupt cleanup, and test restore, clock skew, policy changes, and mixed supported versions. Attempt to refresh expiry metadata under the same id. Pending internal redelivery must retain its deduplication evidence and complete even after the external horizon. Effect and Promise-client retries must preserve identity/expiry, surface expiry without minting a new id, and avoid claiming that expiry proves the earlier operation failed.
- **Two-round-trip turns and state cache:** count database round trips per turn with no handler-issued statements; assert exactly two. Advance the generation from another runner between turns; the stale activation must fail its fence and must not commit from its cached state. Declared failure must leave the cached state unchanged; commit-unknown must discard it.
- **Turn batches:** queue several commands for one actor and assert one transaction, delivery order, one receipt per command, and no reply before commit. Make a middle command return a declared failure; later commands must observe state without its consequences, and its failure receipt must commit. Make a middle command defect; the batch must roll back and redeliver one command per transaction without repeated neighbor rollbacks. Crash before and after the shared commit. Assert that a lone command is not delayed and that no transaction exceeds the batch cap or holds more savepoints than the cap.
- **Placement and single-shard paths:** for each placement key kind, assert that every framework and actor-owned row carries the same `routing_key` and lands on one Neki shard. Run every framework turn, wake, and due-work statement under `__neki.fanout='single'`; any scatter must fail the test. Assert that group queries for one placement key return one snapshot.
- **Due-work scans:** load a large population of sleeping actors with nothing due; timer and wake scan cost must not grow with it.
- **Regional placement:** route a tenant's commands to its home region; deliver a cross-region intent through the outbox relay with crashes before and after destination insert, preserving one logical intent. Singletons must run only in the primary region.
