# 04 — Durable execution

**Responsibility:** define durable work and command guarantees.  
**Authority:** product intent.  
**Owner role:** product direction.  
**Change policy:** a change requires product sign-off and a matching contract update when a promise shifts.

## Vision

Durable execution is part of the actor model, not a second product. Commands, workflows, cron, timers, actor messages, and external effects share identity, tenancy, attribution, and recovery semantics.

## Command guarantees

Every command turn performs the generation fence, receipt lookup, handler, and commit in one transaction. The receipt records success or a declared failure. Reusing the same command id and input replays that outcome; reusing it with different input fails with `CommandConflict`.

This gives exactly-once effect for the actor's committed transition while its receipt is retained. A `Timeout` means the caller stopped waiting, not that the turn failed; retrying with the same command id discovers the receipt.

## Durable consequences

- **Workflows** are actor members for finite, durable operations. They support durable activities, sleep, interruption, and owner-scoped `waitFor` on events.
- **Cron and timers** deliver commands later. `Cron.every` is a lifecycle policy, cluster-wide on a singleton and per-actor otherwise.
- **Effects** represent external side effects committed as obligations, retried after commit, and moved to dead letters when policy is exhausted.
- **Actor intents** deliver commands or workflow controls after the source turn commits.

Effects are at least once. Exactly-once external outcomes require provider idempotency, a transactional handoff, or reconciliation. Dead letters and unknown outcomes are product state, not hidden counters.

## Failure model

An old generation cannot commit after losing its fence. Work committed before a crash remains discoverable. Work not committed disappears with the transaction. Cross-actor operations are durable messages, not distributed transactions.

Framework failures use one `ActorError` with typed reasons: `ActorUnavailable`, `MailboxFull`, `Timeout`, `CommandConflict`, `NotCreated`, `Unauthorized`, `InvalidInput`, and `TransportError`. Application-declared failures remain distinct and replay faithfully.

See [boundaries](08-boundaries.md) for the limits of these guarantees.
