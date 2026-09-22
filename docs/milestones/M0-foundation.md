# M0 — Foundation

**Responsibility:** establish contracts and a runnable test boundary.  
**Authority:** delivery plan.  
**Owner role:** delivery/runtime lead.
**Change policy:** a change requires delivery lead sign-off.

## Included

- Bun/Turbo monorepo from `rika-labs/monorepo-project-template`;
- the `durable-actors` package skeleton with `.`, `/runtime`, `/client`, and `/testing` entries;
- `Actor.make`, identity modes, actor handles, policies, `ActorError`, and runtime schemas;
- `Actors.layer` on Postgres with migrations and one database per deployment;
- command turns with generation fences, receipts, handler execution, durable consequences, and one framework-owned transaction;
- `ActorTest` running the real turn path on PGlite, plus real-Postgres coverage where locking is required;
- a shared PGlite/Postgres conformance harness for persistence, receipts, rollback, and redelivery;
- first ADRs and CI checks.

## Excluded

Connections, workflows, hosted operation, managed deployment, and provider-specific claims beyond proven conformance gates.

## Acceptance tests

- A committed command validates the current generation fence and persists one receipt; a generation is an authority epoch, not a counter incremented by every command.
- An authorized retry within the external retry horizon with the same command ID and input replays the receipt without rerunning the handler.
- An authorized retry within that horizon with different input fails with `CommandConflict`.
- Credential rotation preserves receipt access for the same logical caller; another caller using the same ID receives no outcome and causes no second execution.
- Revocation blocks new external admission and receipt reads without canceling accepted work or its trusted internal redelivery.
- The command identity/expiry and error-mapping design is explicit; expired external IDs are rejected without execution, including after supported cleanup and restart. Effect-handle retries never silently replace expired IDs, and pending internal work retains deduplication evidence.
- A retryable transaction failure before commit persists no state, event, effect, intent, or receipt update and is redelivered.
- An unhandled declared failure rolls back business changes but commits its terminal error receipt in the same fenced transaction; a retry replays the error without running the handler.
- A stale generation cannot commit.
- The same conformance cases run on PGlite and Postgres; lock-contention cases run on Postgres.
- `ActorTest` inspection reads committed state without waking the actor.

## Exit criteria

The repository installs, typechecks, lints, and tests. The framework skeleton exposes only the four settled entries, a disposable Postgres run proves the fenced turn and receipt path, the conformance harness passes on supported databases, and failure evidence is reviewable by a new maintainer.
