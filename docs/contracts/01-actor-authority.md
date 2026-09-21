# Actor identity and authority

**Responsibility:** define what an actor is allowed to do.  
**Authority:** normative.  
**Owner role:** runtime architecture.  
**Change policy:** any authority change requires security review and adversarial tests.

An actor is addressed by `(tenant, actor, id)` within one deployment. Named actors use the declared id schema, minted actors use a framework-issued UUIDv7, and `singleton: true` actors use `X.get()` without an id.

Exactly one generation MAY commit for an actor at a time. Every command turn MUST lock the generation row with `SELECT ... FOR UPDATE`; on Neki it MUST also set `__neki.tx_mode='single'` on the transaction connection. A lease, process memory, TypeScript types, or routing ownership alone MUST NOT authorize a commit.

Command mutation MUST occur only through `CommandContext`. `QueryContext`, `StreamContext`, `WakeContext`, workflow bodies, connection handlers outside a command turn, and `run` receive read-only state/table capabilities. They MAY schedule a command or workflow intent, but MUST NOT mutate actor-owned durable data directly.

A request/reply handle called inside a turn, including a handle captured before the turn, MUST die with `Request/reply inside a turn`; the transaction MUST roll back. Cross-actor work from a turn MUST use durable intents.

Authority tests are specified by [conformance](../verification/01-conformance.md), [failure cases](../verification/02-failure-matrix.md), and invariants A1–A3 in [invariants](../verification/invariants.md).
