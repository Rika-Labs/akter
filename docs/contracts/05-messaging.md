# Messaging and events

**Responsibility:** define actor communication and durable publication.  
**Authority:** normative.  
**Owner role:** runtime/realtime.  
**Change policy:** wire changes require protocol versioning and replay tests.

Outside a turn, a command call MUST be a direct request/reply: it runs in the owner's turn, and the committed receipt is its only durable admission record. Handles MUST retry retryable failures with the same command id. There is no persisted or fire-and-forget command call ([ADR 0011](../decisions/0011-direct-commands-outbox-and-performance.md)).

Inside a command turn, `X.intents(id)` methods, including `Intent.after`/`Intent.at` timers and workflow starts, MUST write `actor_outbox` rows on the sending actor's shard in the turn transaction. They MUST be delivered only after commit, as direct commands whose command id is the intent id, and MAY be delivered more than once; receiver receipts provide idempotency. `Intent.cancel(key)` MUST remove a pending keyed timer in the same transaction. A timer whose delivery the relay has already begun is firing, not pending: cancelling or replacing its key does not stop that delivery, which completes at most one receiver transition, so handlers that must ignore a superseded timer check actor state. Delivering a committed intent is trusted internal recovery of accepted work: it MUST NOT be refused because the originating caller lost access or the external retry window elapsed ([ADR 0011](../decisions/0011-direct-commands-outbox-and-performance.md), [receipts](04-receipts.md)).

Request/reply inside a turn is forbidden. Messaging does not create a distributed transaction and MUST NOT be presented as a synchronous remote call from the sender's transaction.

`turn.emit` MUST append an owner-scoped event only if the turn commits. Events MUST have a monotonically ordered cursor within their declared actor stream; the sequence MUST be assigned under the generation fence, MUST have no gaps between committed events, and MUST never be reissued after pruning. Replay MUST either resume after a valid cursor or return an explicit cursor/retention failure; it MUST NOT silently skip committed events.

A subscriber MAY declare `Actor.subscription` members that follow another actor type's declared events in the same tenant ([ADR 0026](../decisions/0026-cross-actor-event-subscriptions.md)). A committed source event MUST reach each matching subscription as a System command turn delivered through the outbox relay, and MUST take effect at most once per subscription, source, and cursor: the derived command id's receipt and the subscriber's applied cursor both deduplicate it. Within one subscription and one source, deliveries MUST follow source cursor order, with one in flight; nothing else is ordered. A rolled-back source turn MUST deliver nothing. Pruned history MUST reach the subscriber as a `RetentionGap` delivery, never a skip. The publisher's turn MUST NOT do work proportional to its subscribers. Delivery wakes a hibernated or parked subscriber like any command.

Workflow `waitFor(Event, { where, timeout })` MUST observe only the owner actor's events, and registration MUST close the start-to-wait race. A workflow that waits for another actor's event does so through an owner subscription whose handler emits an owner event. See gates **Intent rollback**, **Outbox delivery**, **Subscription delivery**, and **waitFor registration** in [conformance](../verification/01-conformance.md).
