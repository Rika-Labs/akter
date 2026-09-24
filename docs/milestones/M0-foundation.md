# M0 — Foundation

**Responsibility:** establish contracts and a runnable test boundary.  
**Authority:** delivery plan.  
**Owner role:** delivery/runtime lead.
**Change policy:** a change requires delivery lead sign-off.

## Completion and supported scope

The first slice implements the embedded Postgres counter, schema-typed commands, caller capture and authorization, keyed state, generation fencing, receipts, declared-failure rollback, and real-Cluster `ActorTest` fault controls. [ADR 0007](../decisions/0007-foundation-command-protocol.md) specifies its protocol.

The second slice adds the remaining foundation surface: all three identity modes (minted `X.id`/`Actors.mint`, named, singleton via `Sharding.registerSingleton`), `internal` commands, lifecycle policies (`Commands.timeout`/`lockWait`, `Delivery.timeout`, `State.maxBytes`, `Hibernate.after`, `Mailbox.capacity`, `Lifecycle.createdBy`), bounded interruptible turns, deterministic defects with `onDefect`, `System` callers with `onBehalfOf` attribution, `Actor.as`, `Database.pglite`, `test.actor`, and the framework-neutral `conformance`/`describeConformance` harness running the same named cases on PGlite and Postgres. [ADR 0008](../decisions/0008-foundation-completion.md) records the choices and their rationale.

The third slice reconciles both with ADRs 0010–0012 ([ADR 0013](../decisions/0013-m0-reconciliation.md)): `Actor.make(name, { key, state, api, internal, policy })`, input-only handlers reading a per-actor `X.Turn` service, `X.create()` as the only minting path, `Actor.as`/`Actor.tenant` instead of `get` options, telemetry-only defects instead of `onDefect`, and direct commands with no Cluster message storage.

**M0 is complete (2026-09-22).** The [conformance ledger](../verification/01-conformance.md#foundation-evidence) records 35 named cases: 30 run on both PGlite and Postgres, and five independent-connection cases run only on Postgres. Backend-specific tests prove database lifecycle, migration rollback, and real process-kill recovery. Repository checks and semantic review pass; the PR records CI evidence for its exact pushed revision. This closes the foundation milestone, not production, multi-runner, or provider certification. M1 owned data and durable consequences are next. The scope and exit criteria below remain unchanged.

## Included

- Bun/Turbo monorepo from `rika-labs/monorepo-project-template`;
- the `durable-actors` package skeleton with `.`, `/runtime`, `/client`, and `/testing` entries;
- `Actor.make`, identity modes, actor handles, policies, `ActorError`, and runtime schemas;
- `Actors.layer` on Postgres with migrations and one database per deployment;
- command turns with generation fences, receipts, handler execution, durable consequences, and one framework-owned transaction;
- `ActorTest` running the real turn path on PGlite, plus real-Postgres coverage where locking is required;
- a shared PGlite/Postgres conformance harness for persistence, receipts, rollback, and caller retry;
- first ADRs and CI checks.

## Excluded

Connections, workflows, hosted operation, managed deployment, and provider-specific claims beyond proven conformance gates.

## Acceptance tests

- A committed command validates the current generation fence and persists one receipt; a generation is an authority epoch, not a counter incremented by every command.
- An authorized retry within the external retry horizon with the same command ID and input replays the receipt without rerunning the handler.
- An authorized retry within that horizon with different input fails with `CommandConflict`.
- Credential rotation preserves receipt access for the same logical caller; another caller using the same ID receives no outcome and causes no second execution.
- Revocation blocks new external admission and receipt reads without cancelling a turn already running.
- The command identity/expiry and error-mapping design is explicit; expired external IDs are rejected without execution, including after supported cleanup and restart. Effect-handle retries never silently replace expired IDs, and pending internal work retains deduplication evidence.
- A retryable transaction failure before commit persists no state, event, effect, intent, or receipt update, and the caller's retry with the same command id executes it once.
- An unhandled declared failure rolls back business changes but commits its terminal error receipt in the same fenced transaction; a retry replays the error without running the handler.
- A stale generation cannot commit.
- The same conformance cases run on PGlite and Postgres; lock-contention cases run on Postgres.
- `ActorTest` inspection reads committed state without waking the actor.

## Exit criteria

The repository installs, typechecks, lints, and tests. The framework skeleton exposes only the four settled entries, a disposable Postgres run proves the fenced turn and receipt path, the conformance harness passes on supported databases, and failure evidence is reviewable by a new maintainer.
