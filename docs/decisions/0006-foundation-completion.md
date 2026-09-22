# ADR 0006: Foundation identity, policies, defects, and PGlite

**Status:** implementation decision (2026-09-22); evidence is tracked separately.

**Responsibility:** record the second M0 slice: identity modes, lifecycle policies, creation gating, bounded turns, deterministic defects, System callers, and the PGlite test backend.  
**Authority:** design.  
**Owner role:** runtime architecture.  
**Change policy:** supersede through an ADR when persisted identity, policy, or caller semantics change.

## Context

ADR 0005 delivered one command/identity/receipt path on Postgres with `User`/`Anonymous` callers and no policies. M0 still required the remaining foundation surface — all three identity modes, bounded execution, creation gating, defect reporting, internal commands, and a fast embedded backend for tests — without widening into M1+ members.

## Decision

### Identity and registration

`Actor.make` accepts `internal`, `id`, `singleton`, and `lifecycle` alongside `commands` and `state`. The default minted schema brands UUIDv7 values with the actor name, and `Actors.mint(X)` decodes a fresh id. Named actors use the supplied schema through `get(id)`; singletons expose `get()` and register through `Sharding.registerSingleton`, so entity startup stays owned by sharding even on the single embedded runner. `create` exists only on minted actors — `never` in types and a runtime defect otherwise — because named and singleton identities have nothing to mint. Internal commands are reachable only through the internal handle path (`ActorTest.actor`), never on public handles or transports.

### Lifecycle policies

`lifecycle` resolves to one `TurnPolicy`: `Commands.timeout` (default 30 s), `Commands.lockWait` (2 s), `Delivery.timeout` (30 s), `State.maxBytes` (65,536 UTF-8 bytes of the complete encoded state object, including keys and decoding defaults), `Hibernate.after` (60 s idle), `Mailbox.capacity` (unbounded), and `Lifecycle.createdBy` (none). Values are positive integers bounded at 2^31 − 1 milliseconds or bytes. Duplicate policies are rejected at `Actor.make`, and `createdBy` must reference a command of the same actor so the gate cannot point at an unreachable command.

The execution deadline is enforced twice: an interruptible timeout on the whole framework transaction, which rolls back and dies `RetryTurn`, and transaction-local `statement_timeout`/`lock_timeout` so a stuck statement cannot outlive the turn's budget. `Delivery.timeout` only detaches the waiting caller; the persisted message continues to completion. An uncertain commit never resolves to a terminal success or failure — the same envelope is redelivered and resolves through its receipt.

### Creation gating

Migration `0002_creation` adds `actor_generations.created` defaulting `false`. The check runs after receipt lookup under the generation lock, so a replayed failed-creation receipt resolves normally while a non-creating command on an uncreated actor fails `NotCreated` without writing a receipt. A failed creating turn rolls back business work, retains its error receipt, and stays uncreated; the first success sets `created` atomically with state and receipt. Existing v1 deployments read unchanged, but rows created before a `createdBy` policy existed keep `created = false`, so adding the policy to an actor with live data requires an explicit application migration that backfills the marker.

### Deterministic defects and `onDefect`

Retryable causes — `RetryTurn` and retryable `SqlError` — die so Cluster restarts the activation and redelivers the same envelope. Other defects are deterministic: the turn rolls back, no receipt is written, the entity returns `Outcome.Defect` (the caller observes `Die`), and the activation stays resident. `toLayer(handlers, { hooks: { onDefect(ctx, cause) } })` receives a `WakeContext` whose `state` is a lazy read of committed state that may itself die on corrupt data; the hook is invoked with that context rather than a pre-decoded snapshot, so snapshot corruption cannot suppress the hook. The hook is interruptible but bounded by the execution deadline, and its failure is reported as an `AggregateError` containing the original cause — defect reporting must never silently replace the defect.

### System callers and attribution

`Caller` gains `System({ source, ref?, onBehalfOf? })` with `source` covering actor, timer, cron, workflow, and effect origins. `ctx.principal` is an `Option`: `User` contributes its subject, `System` contributes `onBehalfOf`, and `Anonymous` contributes none. The receipt caller key persists source, ref, and delegation so distinct internal origins cannot read each other's receipts. Attribution remains trusted application input — it is not authentication, and hosted assertion or transport credential verification is not implemented. `Actor.as(caller)` scopes `CurrentCaller` while acquiring handles; acquired handles keep the captured caller.

### PGlite test backend

`Database.pglite` builds a fresh owned instance per layer build; a supplied `liveClient` keeps its own methods and lifetime. Owned instances wrap `query` to track in-flight protocol exchanges and drain them before `close()`, because the pinned PGlite driver deadlocks when closed mid-exchange. `ActorTest.layer` defaults `database` to a fresh in-memory PGlite, honors `dataDir` for disk persistence across builds, and treats a `Redacted` URL as Postgres. On PGlite the Cluster runner bookkeeping layer uses memory storage, because `SqlRunnerStorage` reserves the single connection for the layer's lifetime and would starve every turn. That substitution is safe only because `SingleRunner` already makes runner state process-local; it confers no independent-connection or concurrent-ownership guarantee, which is why the conformance backend flags `independentConnections: false` on PGlite.

### Conformance harness

`durable-actors/testing` exports `conformance` (named cases) and `describeConformance` (a registrar-driven suite). The harness is framework-neutral: registrars inject `describe`/`it`/`expect` and a required `skip`, so inapplicable cases are reported by name rather than dropped. The same names run on PGlite and Postgres; real SIGKILL and independent-connection cases run on Postgres only.

## Alternatives

- A `created` flag written in a second transaction would race the turn commit and is rejected; the marker lives inside the fenced transaction.
- Pre-decoding `onDefect` state would hide defects caused by corrupt state and is rejected; the lazy read keeps the hook reachable.
- Sharing `SqlRunnerStorage` on PGlite would deadlock the single connection; in-memory runner bookkeeping under `SingleRunner` is the minimal substitution.
- Silently skipping non-applicable cases was rejected; `registrar.skip` records them by name.
- The v1 command protocol and retry window are unchanged; no rolling mixed-version support is claimed.

## Consequences, evidence, and revisit conditions

Singleton registration exists, but multi-runner residency, migration, `run` loops, and cron remain unverified and unclaimed. `createdBy` on pre-existing data requires an application migration. Executed foundation results are recorded in [conformance](../verification/01-conformance.md#foundation-evidence); the PR binds CI evidence to its exact revision. Revisit before multi-runner singleton semantics, cleanup/restore, transport authentication, or protocol v2.
