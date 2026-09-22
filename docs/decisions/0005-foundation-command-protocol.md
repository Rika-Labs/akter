# ADR 0005: Foundation command protocol

**Status:** implementation decision (2026-09-22); evidence is tracked separately.

**Responsibility:** specify the first embedded command, identity, receipt, and transaction implementation.
**Authority:** design.
**Owner role:** runtime architecture.
**Change policy:** supersede through an ADR when persisted identities or access semantics change.

## Context

ADR 0004 settled receipt privacy, revocation, and finite retries, but left their encoding and errors open. The first M0 slice needs concrete records and a runnable Postgres boundary before additional actor members or transports.

## Decision

### Identity and admission

A v1 command ID is `v1.<issuedAtMs>.<expiresAtMs>.<uuid>`. Times are canonical positive decimal integers and the nonce is a lowercase UUIDv4. All components constitute the identity: editing a time creates a different operation, never a refreshed retry. The embedded runtime mints times from the database clock. A command Effect retains its identity across reruns; constructing another command Effect creates a new operation. An explicit `Actor.commandId(id)` preserves the supplied identity.

The deployment records its protocol version and retry window (default 24 hours). A runtime with different settings fails startup; changing the window requires an explicit migration rather than silently reinterpreting retained IDs. Admission requires `issuedAt <= databaseNow < expiresAt` and exactly the configured window. Future, malformed, or unsupported IDs are terminal invalid identities. There is no future-clock grace in v1. External replay rechecks expiry and authorization before returning an outcome. Expiry does not establish whether an earlier attempt committed.

The first version has no automatic receipt or Cluster-message cleanup. Its expiry check is independent of receipt presence; tests may remove completed receipts to prove an old ID cannot execute again. Pending accepted messages and their receipts must not be pruned. Restore and clock rollback across a pruned history, rolling protocol upgrades, and cleanup automation remain unsupported until separately verified.

### Logical caller and authorization

The first embedded caller schema supports `User(subject)` and `Anonymous`. Subject is a stable application identity, not a credential. Anonymous is deliberately one shared logical identity; separate anonymous-client privacy is not provided. System/on-behalf-of and receipt-scoped operator access are reserved for later implementation, not exposed as client-selectable recovery flags.

`Actors.layer` requires an authorization function, called at external admission and before result delivery with the captured caller, actor reference, and command. Applications can consult current permission state on every call. The receipt stores the original caller key. Caller mismatch never partitions deduplication, reveals an outcome, or invokes the handler. Persisted Cluster envelopes are trusted accepted work; replaying them does not reauthorize or reapply external expiry. Only the runtime can create that delivery path.

`Unauthorized` gains `access_denied` and `receipt_access_denied` codes (future HTTP mapping: 403; existing credential codes remain 401). `CommandExpired` and `InvalidCommandId` are new terminal `ActorError` reasons (future HTTP mappings: 410 and 400). Both appear in typed embedded command error channels, unlike boundary-only `InvalidInput` and `TransportError`. There are no previously shipped wire clients to migrate. Unknown protocol versions fail closed; serving, OpenAPI, and Promise-client mappings must use these same schemas when implemented.

### One turn, one commit

Use one persisted Effect Cluster entity per actor type, serialized handlers, no Cluster primary key, and `WithTransaction: false`. The actor generation is acquired once per activation on its first turn, not incremented per command. Every attempt locks and validates the generation row. An activation replacement changes the generation under that lock; the old generation cannot commit a later turn.

The framework transaction resolves receipts, decodes state, executes the command, and commits state and its outcome. A nested `SqlClient.withTransaction` uses the same connection and a Postgres savepoint for business work. Declared failures roll back to that savepoint and commit only the terminal failure receipt in the outer transaction. Typed application errors are schema-encoded and reconstructed on replay. Defects do not become declared failures. SQL/retryable failures restart the Cluster activation; deterministic decoding/capability defects return to the caller without committing business work.

Inputs, outputs, state, and declared errors use Effect-derived JSON codecs. Receipt hashes use SHA-256 over Postgres's JSONB text normalization: object key order is immaterial, while array order is preserved. This is a deployment-local encoding; another adapter must reproduce it or introduce an explicit protocol migration.

Cluster replies are written only after the framework transaction commits. Loss between those commits redelivers the persisted command and resolves its receipt. Disconnecting a waiter cannot cancel accepted execution. Runtime shutdown and actual process death remain separate recovery cases.

## Alternatives

- Separate caller-specific receipt keys would permit duplicate business operations and are rejected.
- A mutable expiry field next to an opaque ID would permit refreshing an old operation and is rejected.
- Permanent tombstones or admission-signing infrastructure are unnecessary for this embedded v1 slice; authenticated transport tokens can be added only with their own requirement.
- An in-memory mailbox or handler-only test context would bypass the durability boundary and is rejected.
- Full M0, singleton residency, state migrations, owned rows, intents, effects, PGlite, and multi-runner operation are not implied by this slice.

## Consequences, evidence, and revisit conditions

The framework stays private and single-runner/embedded. New framework tables live inside the framework package, not the control-plane database package. Postgres failure tests must cover fencing, duplicate races, rollback, lost replies, isolation, revocation, expiry, and committed inspection. The conformance ledger records which were executed. Revisit this protocol before cleanup, restore support, new caller modes, served clients, or rolling upgrades are claimed.
