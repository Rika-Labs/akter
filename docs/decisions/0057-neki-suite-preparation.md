# ADR 0057: The Neki suite is prepared, selected by environment, and never counted as run

**Status:** proposed (2026-09-30). It amends [ADR 0020](0020-two-round-trip-turn-pipeline.md)'s admission group for Neki and completes the M5.1 half of [ADR 0006](0006-scale-rules-placement-and-query-tiers.md)'s CI check and [ADR 0033](0033-parent-actor-placement.md)'s Neki check for families.

**Responsibility:** decide how the conformance suite reaches Neki without a Neki run, where a turn connection sets Neki's session modes, and what the single-shard statement check proves before and after a Neki run.

**Authority:** design decision record.

**Owner role:** runtime and verification.

**Change policy:** supersede through a new ADR.

## Context

M5.1 ([M5](../milestones/M5.md), [#296](https://github.com/Rika-Labs/akter/issues/296)) prepares the Neki suite; running it is [#66](https://github.com/Rika-Labs/akter/issues/66). Three facts shape it:

- Neki's documentation says the transaction mode is chosen before a transaction starts (`SET __neki.tx_mode = 'single'; BEGIN;`), and that `__neki.fanout` is a session setting that rejects a statement whose routing shape is wider than the setting. `EXPLAIN (NEKI_PLAN)` prints the router's plan; the documentation says the fanout setting applies to it only with `ANALYZE`, which runs the statement. ADR 0020 put the mode in the admission group's `set_config`, after `BEGIN`.
- About half of the conformance groups open empty databases through `environment.freshDatabase` or copy one with `environment.snapshot`, which the Postgres backend does with `CREATE DATABASE ... TEMPLATE`. Nothing shows that a Neki router allows that, so the Neki backend does not try.
- Nothing here has run against Neki. Neki's plan text, its accepted startup settings, and its topology setup are taken from its documentation.

## Decision

1. **Session settings, not turn settings.** With `NekiTurnSessions` set, each session in the turn pool runs `SET __neki.tx_mode = 'single'` and `SET __neki.fanout = 'single'` on its first lease, before any turn sends `BEGIN`. The admission group is unchanged, so Postgres and PGlite statement counts and round trips do not move. Whether a pipelined turn keeps two flights on Neki stays the **Neki locking and pinning** gate's question. A session whose settings fail is dropped from the pool. Only the turn pool is set: queries, the relay, and Cluster's storage use the off-turn pool and keep Neki's defaults.
2. **Selection by environment, skipped by name.** `TEST_NEKI_DATABASE_URL` names a Neki router. `neki/backend.test.ts` runs the suite against it, and with the variable unset registers every case as skipped under a suite name that states why. `ConformanceBackend.neki` turns on the session settings and the cases flagged `requiresNeki`; every other backend reports those cases through `registrar.skip`. A skipped case is never recorded as a pass.
3. **Groups that need a fresh database are left out, and a test says so.** The Neki suite runs every group except those in `neki/groups.ts`, so a new group runs on Neki unless it needs a database of its own. The excluded groups' cases are registered as skipped, with the reason in the suite name. `neki/groups.test.ts` reads each group's module and fails if a running group opens a fresh database or a snapshot, or an excluded group does not. A Neki deployment that can hand out empty databases removes the restriction one group at a time.
4. **The single-shard check has two halves.**
   - _Local, every backend._ A statement recorder reads each statement the runtime compiles (`Statement.CurrentTransformer`). Over a workload of a turn, a wake, a due-work scan, and the ADR 0033 families (state, events, blobs, owned rows, outbox, mint, and both group reads), every statement that touches a per-actor table must name a `routing_key` predicate or insert, or probe `bucket`. This is a precondition, not proof: a statement can name a routing key and still plan as a scatter.
   - _Neki._ The same recorded statements run under `EXPLAIN (NEKI_PLAN, COSTS OFF, FORMAT TEXT)` with their recorded parameters, and each plan must be one `Route` of a kind Neki documents as single-shard (`EqualUnique`) and no router operator. Anything else, including a plan the parser does not know, fails with the plan printed. Keyed statements and due-work scans are separate cases, so a scan finding does not hide a keyed one.
5. **No unkeyed statement is allowed.** The local check fails on any statement that touches a per-actor table without naming a routing key, so a new one cannot land unnoticed.

## Findings

- **Due-work scans probe every bucket.** The relay's intent and effect claims run `generate_series(first, last)` over all 256 buckets without a `routing_key` predicate. [ADR 0021](0021-multi-runner-relay-singleton-and-cron.md) says the relay claims one bucket range per shard on Neki, but only the parameterised bucket range exists, not the per-shard claims or the shard map. The local check pins that the range is a parameter, so per-shard claims need no new statement. On Neki, expect the scan case to report `Route [Scatter]` until they exist.
- **A minted actor's creating-intent proof read its parent's outbox row.** The keyed read added in [#302](https://github.com/Rika-Labs/akter/issues/302) still crossed shards when the parent was placed elsewhere, so single transaction mode could refuse the child's turn. [ADR 0048's child-local proof amendment](0048-mint-progress-and-inspection-record-corrections.md#amendment-child-local-creating-intent-proof-485-2026-10-03) resolves #485 by carrying the claimed row's sender provenance with the relay request. The child's first turn now validates that delivery without reading the parent or its placement registry. The recorder checks opposite routing-key halves on every backend; actual Neki single-shard execution remains unverified until #66.

## Alternatives rejected

- **`set_config('__neki.tx_mode', ...)` in the admission group.** Neki's documentation sets the mode before the transaction starts, so a setting made inside `BEGIN` may be too late. It would also change the statement text of every backend.
- **Startup parameters.** The router's acceptance of `__neki.*` in the startup packet is not documented.
- **Silently registering only the groups that work.** The cases would vanish from the report. A skip carries its name and reason.
- **A Neki-only workload for the statement check.** The local half runs on every backend so a regression shows in CI, not first in #66.

## Consequences

- The support matrix and ledger say "prepared; unverified, pending #66" for the affected Neki cells. No Neki behaviour is claimed.
- `Database.postgres` gains no option; `NekiTurnSessions` is an internal reference until Neki is supported.
- Dallen's run needs a router whose topology places every framework table by `routing_key`, and `TEST_DATABASE_URL` for the integration config's template.
