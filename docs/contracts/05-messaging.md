# Messaging and events

**Responsibility:** define actor communication and durable publication.  
**Authority:** normative.  
**Owner role:** runtime/realtime.  
**Change policy:** wire changes require protocol versioning and replay tests.

Outside a turn, a command call MUST be a direct request/reply: it runs in the owner's turn, and the committed receipt is its only durable admission record. Handles MUST retry retryable failures with the same command id. There is no persisted or fire-and-forget command call ([ADR 0011](../decisions/0011-direct-commands-outbox-and-performance.md)).

Inside a command turn, `X.intents(id)` methods, including `Intent.after`/`Intent.at` timers and workflow starts, MUST write `actor_outbox` rows on the sending actor's shard in the turn transaction. They MUST be delivered only after commit, as direct commands whose command id is the intent id, and MAY be delivered more than once; receiver receipts provide idempotency. `Intent.cancel(key)` MUST remove a pending keyed timer in the same transaction. A timer whose delivery the relay has already begun is firing, not pending: cancelling or replacing its key does not stop that delivery, which completes at most one receiver transition, so handlers that must ignore a superseded timer check actor state. Any runner's relay may claim a due row with a lease. A claimed row is not due until its claim settles or its lease ends; a row whose claiming relay dies is delivered again, under the same intent id, after the lease ends. A row whose delivery fails or whose settle dies MUST back off with a capped delay, so it cannot hold back newer due rows; committed intents have no retry limit ([ADR 0021](../decisions/0021-multi-runner-relay-singleton-and-cron.md)). Delivering a committed intent is trusted internal recovery of accepted work: it MUST NOT be refused because the originating caller lost access or the external retry window elapsed ([ADR 0011](../decisions/0011-direct-commands-outbox-and-performance.md), [receipts](04-receipts.md)).

A `policy.cron` entry is a keyed timer on its own actor, with the reserved key prefix `$cron:`; application code MUST NOT stage or cancel a `$cron:` key. At most one tick per entry is pending; a claimed tick fires once and is rewritten to the next scheduled time only after its receipt commits ([background work](08-background-work.md)).

Request/reply inside a turn is forbidden. Messaging does not create a distributed transaction and MUST NOT be presented as a synchronous remote call from the sender's transaction.

`turn.emit` MUST append an owner-scoped event only if the turn commits. Events MUST have a monotonically ordered cursor within their declared actor stream; the sequence MUST be assigned under the generation fence, MUST have no gaps between committed events, and MUST never be reissued after pruning. Replay MUST either resume after a valid cursor or return an explicit cursor/retention failure; it MUST NOT silently skip committed events.

Workflow `waitFor(Event, { where, timeout })` MUST observe only the owner actor's events, and registration MUST close the start-to-wait race. See gates **Intent rollback**, **Outbox delivery**, and **waitFor registration** in [conformance](../verification/01-conformance.md).
