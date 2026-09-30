# 04 — Durable execution

**Responsibility:** define durable work and command guarantees.  
**Authority:** product intent.  
**Owner role:** product direction.  
**Change policy:** a change requires product sign-off and a matching contract update when a promise shifts.

## Vision

Durable execution is part of the actor model, not a second product. Commands, workflows, cron, timers, actor messages, and external effects share identity, tenancy, attribution, and recovery semantics.

## Command guarantees

Every command turn performs the generation fence, receipt lookup, handler, and commit in one transaction. The receipt records success or a declared failure. Reusing the same command id and input replays that outcome; reusing it with different input fails with `CommandConflict`.

Commands are direct: nothing is durable until the turn commits, and the caller's handle retries with the same command id. Work that must outlive its caller is an intent or a workflow. This gives exactly-once effect for the actor's committed transition while its receipt is retained. A `Timeout` means the caller stopped waiting, not that the turn failed; retrying with the same command id discovers the receipt.

## Durable consequences

- **Workflows** are actor members for finite, durable operations. They support durable activities, sleep, interruption, and owner-scoped `waitFor` on events.
- **Cron and timers** deliver commands later through the outbox. `policy.cron` is cluster-wide on a singleton and per-actor otherwise; `Intent.after`, `Intent.key`, and `Intent.cancel` manage timers from turns.
- **Effects** represent external side effects committed as obligations, retried after commit, and moved to dead letters when policy is exhausted.
- **Actor intents** deliver commands or workflow controls after the source turn commits.

Effects are at least once. Exactly-once external outcomes require provider idempotency, a transactional handoff, or reconciliation. Dead letters and unknown outcomes are product state, not hidden counters.

## Failure model

An old generation cannot commit after losing its fence. Work committed before a crash remains discoverable. Work not committed disappears with the transaction. Cross-actor operations are durable messages, not distributed transactions.

Framework failures use one `ActorError` with typed reasons: `ActorUnavailable`, `MailboxFull`, `RunnerAtCapacity`, `Timeout`, `CommandConflict`, `CommandExpired`, `InvalidCommandId`, `NotCreated`, `Unauthorized`, `SessionEnded`, `InvalidInput`, and `TransportError`. Application-declared failures remain distinct and replay faithfully.

See [boundaries](08-boundaries.md) for the limits of these guarantees.
