# Actor identity and authority

**Responsibility:** define what an actor is allowed to do.  
**Authority:** normative.  
**Owner role:** runtime architecture.  
**Change policy:** any authority change requires security review and adversarial tests.

An actor is addressed by `(tenant, actor, id)` within one deployment. Named actors use the declared id schema, minted actors use a framework-issued UUIDv7 from `X.create()` or a UUIDv8 derived by `turn.mint` inside the parent's turn from the tenant, parent identity, command id, call ordinal, and child type. `turn.mint` implements [ADR 0025](../decisions/0025-turn-mint.md)'s proposed defaults, pending acceptance: a child minted by `turn.mint` MUST be created only by the relay delivering its parent's same-turn creating intent: the runtime MUST reject a mint proof presented through `Actor.as`, a client, or any other external entry point, and the creating transaction MUST find that intent's committed row, with the same command id, command, and payload, in the parent's outbox, which stays until the delivery commits and which retention never prunes; and `key: Actor.singleton` actors use `X.get()` without an id.

Exactly one generation MAY commit for an actor at a time. Every command turn MUST lock the generation row with `SELECT ... FOR UPDATE`; on Neki it MUST also set `__neki.tx_mode='single'` on the transaction connection. A lease, process memory, TypeScript types, or routing ownership alone MUST NOT authorize a commit.

Command mutation MUST occur only through the `X.Turn` service. Query and activation read contexts expose read-only state/table capabilities, not command authority. Workflow bodies access actors through workflow handles rather than direct state/table capabilities; [ADR 0022](../decisions/0022-workflow-engine-storage-and-version-markers.md) confines those handle calls to activities. Only contexts that expose intent handles MAY schedule commands or workflow intents; queries do not acquire those capabilities merely by being read-only. See the [context capability matrix](../api/02-context.md).

A request/reply handle called inside a turn, including a handle captured before the turn, MUST die with `Request/reply inside a turn`; the transaction MUST roll back. Cross-actor work from a turn MUST use durable intents from `X.intents(id)`.

Authority tests are specified by [conformance](../verification/01-conformance.md), [failure cases](../verification/02-failure-matrix.md), and invariants A1–A3 in [invariants](../verification/invariants.md).
