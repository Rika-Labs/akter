# ADR 0003: Failure rollback, automatic scoping, drain, and hosted trust

**Status:** accepted design (2026-09-22); implementation and conformance remain pending.

**Responsibility:** record the owner's implementation choices before decomposing the framework backlog.

**Authority:** historical decision record.

**Owner role:** runtime architecture.

**Change policy:** supersede through a new ADR when these semantics change.

## Context

[ADR 0002](0002-v4-contract-clarifications.md) left declared-error write semantics, supported SQL mutation shapes, and operational details open. The owner selected business-write rollback with a retained failure receipt, initially scoped writes, bounded graceful drain, and signed internal assertions over TLS. The owner also requested interchangeable adapters that automatically scope data access without application-supplied tenant or actor ownership fields.

This ADR resolves those choices, not the remaining implementation details. It does not implement the framework or claim that any backend or adapter is supported.

## Decisions

### Declared failures roll back business work, not their receipt

An unhandled application-declared failure rolls back the turn's business changes, including state migration writes, owned rows, blobs, events, timers, actor/workflow intents, and effect obligations. The framework also discards staged state snapshots and broadcast frames. The generation fence and terminal failure receipt remain in the one framework-owned transaction, which commits before the error becomes observable.

A savepoint after fence/receipt resolution and before business work is a candidate mechanism, not a proven adapter capability. SQL rollback must be accompanied by discarding staged in-memory consequences. If that transaction fails before commit, neither the receipt nor the business work survives. After commit, redelivery replays the declared failure without running the handler.

An error caught by the handler followed by success commits normally. A domain rejection that intentionally persists business changes belongs in the command's output schema. There is no per-command commit-on-error switch. Defects still roll back the whole transaction; activation-local `vars` are not transaction state and are not automatically rolled back.

### Supported adapters automatically scope the initial write surface

Initial application mutations use `ctx.rows(table)` scoped operations; `ctx.db` remains available for authorized relational reads and joins, not unrestricted advanced mutation. Supported adapters derive tenant, actor ownership, execution phase, and transaction binding from trusted runtime context. Developers do not supply `tenant_id` or `actor_id` in ordinary actor-row payloads or predicates, and adapters reject attempts to override ownership.

This is a shared adapter contract, not Drizzle-specific application boilerplate. A query-client integration must preserve it on the configured backend; a backend adapter must additionally prove storage, fencing, rollback, and recovery behavior. Neither kind may silently use an independent transaction or expose an unscoped write client. Queries and other read phases remain read-only, and a captured transaction-bound capability cannot outlive its turn.

Drizzle/Postgres remains the first target. Other integrations are intended to work with the same automatic scoping once supported, but no particular new ORM or database is selected here. Arbitrary third-party clients do not acquire scoping merely by being called from a handler. A supported adapter needs an explicit operation matrix and the shared ownership/transaction tests; unsupported operations fail closed. Authorized cross-actor reads remain an explicit capability, not accidental scope widening.

Ownership columns still exist in the database. Compute placement and optional RLS do not replace ownership enforcement. Future advanced mutations require additional conformance evidence before expanding the supported surface; this decision does not introduce a universal query language or a new public package entry.

### Runners drain within a bounded deadline

Readiness requires usable storage, compatible schemas, registered actors, operational routing, and a runner that is not draining. It does not require every actor to be awake or every workflow to finish.

Drain stops new local admission and acquisition of additional work, gives in-flight work a bounded opportunity to finish, then interrupts remaining local execution. Pending durable work stays recoverable. Ownership is released only when an old writer cannot still commit; otherwise safe expiry and fencing govern recovery. The outcome distinguishes a clean drain from deadline expiry or forced shutdown.

Interruption does not undo a provider call. Provider ambiguity remains visible and subject to reconciliation or proven idempotency. Runner drain is not deployment-wide quiescence for restore. The concrete `RuntimeControl` signatures and default deadline remain implementation design work; the illustrative 30-second deadline is not a selected default.

### Hosted ingress uses signed assertions over TLS

The trusted edge authenticates the external credential, derives authorized deployment/tenant attribution, and issues a short-lived internal assertion signed with an edge private key. Runners verify trusted issuer/key, permitted algorithm, deployment audience, expiry, and binding to the requested actor, operation, command identity, and payload before admission. Runners receive verification keys, not the edge signing key. Verified identity still requires resource/operation authorization.

The edge replaces client-supplied attribution. Durable envelopes contain verified caller attribution, not API keys, raw credentials, or the transport assertion. Expiration of the assertion does not cancel already admitted work or prevent receipt recovery through a newly authenticated request. Key rotation, revocation, request binding, and streaming-session authorization need an explicit tested protocol before hosted support is claimed.

Operator actions require separate action- and resource-scoped capabilities and audited repair intents. Application credentials or a claimed System caller do not grant operator authority. Permission to retry an effect is not proof that repeating an ambiguous provider call is safe.

## Alternatives

- Commit preceding business writes on a declared failure: rejected because a failure should not silently preserve partial business work.
- Configure error-commit behavior per command: rejected in favor of one rule and explicit domain-result values.
- Require application ownership predicates or accept arbitrary raw mutation: rejected because scoping belongs to the framework and unsupported mutation must not bypass it.
- Promise every ORM/database immediately: rejected; adapter portability is a goal, while support requires evidence.
- Wait indefinitely during drain, or routinely stop immediately: rejected in favor of bounded graceful drain with crash recovery when necessary.
- Trust private-network headers: rejected. Mutual TLS may complement the chosen mechanism later but is not required infrastructure for the initial design.

## Consequences and evidence

The contracts, API guidance, deployment and security requirements, failure matrix, and conformance cases must agree on these choices. The existing 17-row v4 gate ledger remains historical; the additional checks in [conformance](../verification/01-conformance.md#implementation-decision-checks) also gate the corresponding features.

Required evidence includes failure-receipt commit/crash cases with no surviving business consequences; concurrent cross-tenant and cross-actor adapter isolation without manual ownership predicates; rejected ownership overrides and escaped turn capabilities; clean and deadline-expired drains with safe takeover; and forged, expired, misbound, or unauthorized hosted assertions and operator actions. None has been executed by this documentation change.

## Revisit when

- A target backend cannot preserve business rollback and a terminal receipt within one fenced transaction.
- A concrete workload needs a new query-client integration or advanced mutation shape.
- Deployment evidence requires different drain defaults or additional transport identity controls without weakening authority.
