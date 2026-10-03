# Actor identity and authority

**Responsibility:** define what an actor is allowed to do.  
**Authority:** normative.  
**Owner role:** runtime architecture.  
**Change policy:** any authority change requires security review and adversarial tests.

An actor is addressed by `(tenant, actor, id)` within one deployment. Named actors use the declared id schema, minted actors use a framework-issued UUIDv7 from `X.create()` or a UUIDv8 derived by `turn.mint` inside the parent's turn from the tenant, parent identity, command id, call ordinal, and child type; `key: Actor.singleton` actors use `X.get()` without an id. Under [ADR 0033](../decisions/0033-parent-actor-placement.md), a parent-placed child's id is `c1.<byte length of the parent id>.<parent id>.<local id>`, so its routing key comes from its address alone; its key validates the local part, a minted one's local part is the UUIDv8 its parent's turn derived and its creating intent must come from the parent its id names, and parent placement is placement, not authority.

Under [ADR 0025](../decisions/0025-turn-mint.md), amended by [ADR 0048](../decisions/0048-mint-progress-and-inspection-record-corrections.md#amendment-child-local-creating-intent-proof-485-2026-10-03), a child minted by `turn.mint` MUST be created only by the relay delivering its parent's same-turn committed creating intent. The relay MUST copy the committed row's sender, target, caller, intent id, command, and payload into the trusted internal delivery. External admission MUST reject a presented mint proof or intent provenance, including before receipt replay. The creating turn MUST require provenance whose sender and tenant match the minting caller, and a mint proof deriving the target id; a missing or mismatched proof fails `Unauthorized` without a receipt. It MUST NOT read the parent's outbox or placement registry: its per-actor statements touch only the child's routing key. The parent's outbox row stays until the delivery commits and retention never prunes it.

Exactly one generation MAY commit for an actor at a time. Every command turn MUST lock the generation row with `SELECT ... FOR UPDATE`; on Neki it MUST also set `__neki.tx_mode='single'` on the transaction connection. A lease, process memory, TypeScript types, or routing ownership alone MUST NOT authorize a commit.

Command mutation MUST occur only through the `X.Turn` service. Query and activation read contexts expose read-only state/table capabilities, not command authority. Workflow bodies access actors through workflow handles rather than direct state/table capabilities; [ADR 0022](../decisions/0022-workflow-engine-storage-and-version-markers.md) confines those handle calls to activities. Only contexts that expose intent handles MAY schedule commands or workflow intents; queries do not acquire those capabilities merely by being read-only. See the [context capability matrix](../api/02-context.md).

A request/reply handle called inside a turn, including a handle captured before the turn, MUST die with `Request/reply inside a turn`; the transaction MUST roll back. Cross-actor work from a turn MUST use durable intents from `X.intents(id)`.

Authority tests are specified by conformance, [failure cases](../verification/02-failure-matrix.md), and invariants A1–A3 in [invariants](../verification/invariants.md).
