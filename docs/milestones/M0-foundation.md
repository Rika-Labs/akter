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

- A committed command increments its generation and persists one receipt.
- Repeating the same command ID and input replays the receipt without rerunning the handler.
- Reusing a command ID with different input fails with `CommandConflict`.
- A failure before commit persists no state, event, effect, intent, or receipt update and is redelivered.
- A stale generation cannot commit.
- The same conformance cases run on PGlite and Postgres; lock-contention cases run on Postgres.
- `ActorTest` inspection reads committed state without waking the actor.

## Exit criteria

The repository installs, typechecks, lints, and tests. The framework skeleton exposes only the four settled entries, a disposable Postgres run proves the fenced turn and receipt path, the conformance harness passes on supported databases, and failure evidence is reviewable by a new maintainer.
