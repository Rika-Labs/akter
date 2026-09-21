# Messaging and events

**Responsibility:** define actor communication and durable publication.  
**Authority:** normative.  
**Owner role:** runtime/realtime.  
**Change policy:** wire changes require protocol versioning and replay tests.

Inside a command turn, `ctx.self.Command.send/after/at`, `ctx.actors.get(...).Command.send`, and `ctx.self.Workflow.start/cancel` MUST create durable intents in the turn transaction. They MUST be delivered only after commit and MAY be delivered more than once; receiver receipts provide idempotency.

Request/reply inside a turn is forbidden. Messaging does not create a distributed transaction and MUST NOT be presented as a synchronous remote call from the sender's transaction.

`ctx.emit` MUST append an owner-scoped event only if the turn commits. Events MUST have a monotonically ordered cursor within their declared actor stream. Replay MUST either resume after a valid cursor or return an explicit cursor/retention failure; it MUST NOT silently skip committed events.

Workflow `waitFor(Event, { where, timeout })` MUST observe only the owner actor's events, and registration MUST close the start-to-wait race. See gates **Intent rollback**, **Neki intent relay**, and **waitFor registration** in [conformance](../verification/01-conformance.md).
