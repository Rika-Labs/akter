# Glossary

**Responsibility:** keep vocabulary consistent across agents and packages.  
**Authority:** normative terminology.  
**Owner role:** product/runtime architecture.
**Change policy:** a term change requires a consistency pass over every document that uses it.

- **Actor:** durable application boundary around an identity and its mutation authority.
- **ActorRef:** serializable actor address containing actor name, tenant, and actor ID.
- **Activation:** disposable in-memory process representation of an actor.
- **Actor definition:** the one data object passed to `Actor.make`, with sections `key`, `placement`, `state`, `tables`, `blobs`, `events`, `effects`, `api`, `internal`, and `policy`.
- **Named actor:** actor whose `key` is an id schema, resolved with `X.get(id)`.
- **Minted actor:** actor with no `key`; `X.create()` mints its id, and no row is written until its first turn.
- **Singleton:** actor with `key: Actor.singleton`, resolved with `X.get()`, and active at most once cluster-wide.
- **Generation:** fenced authority epoch for an activation.
- **Turn:** one bounded command execution and its transaction, which a turn batch shares.
- **Turn batch:** consecutive turns for one actor, already waiting in its mailbox, committed in one transaction; each command keeps its own receipt and failure isolation.
- **Placement key:** the value whose rows share a shard: the tenant by default, or the actor or a parent actor.
- **Routing key:** framework-computed 64-bit hash of a placement key, stored on every actor-owned row and used for shard placement.
- **Home region:** the deployment region whose database holds a tenant's actors and rows; assigned only by an operator.
- **Query tier:** local (one actor), group (one placement key, one shard), or fleet (declared `Fleet.view`, eventually consistent, outside turns).
- **Command:** authenticated request addressed to one actor, delivered directly and implemented by a server handler.
- **Reducer:** pure state transition declared in the contract; runs optimistically in browser handles and may merge commutatively.
- **Context service:** the typed per-phase context (`X.Turn`, `X.Read`, `X.Connection`, `X.Workflow`, `X.Executor`) a handler obtains with `yield*`.
- **Receipt:** durable record of one logical command identity and outcome; the only durable admission record of a direct command.
- **Command ID:** client-minted idempotency identity reused across delivery retries.
- **Event:** committed fact available for delivery or replay.
- **Intent:** durable actor message, timer, workflow start, or effect obligation written to `actor_outbox` by a turn and delivered after commit.
- **Outbox:** the actor-shard `actor_outbox` table that carries every intent; its relay delivers due rows as direct commands.
- **Effect:** external I/O requested by `turn.perform`, persisted with the turn, and executed after commit by `X.toEffectLayer`; its result and dead letter reach the actor through declared `onSuccess` and `onDeadLetter` routes.
- **Internal command:** a command in the `internal` section, callable only by System callers.
- **Workflow:** durable orchestration declared as an actor member with `Actor.workflow`.
- **WorkflowRun:** handle returned by a workflow start, exposing identity, result, polling, and interruption.
- **Keyed state:** schema-defined actor state loaded and written inside fenced turns.
- **Activation-local value:** a value such as a `Ref` created in a layer's build Effect; discarded on hibernation.
- **Owned table:** Drizzle table scoped by `tenant_id` and `actor_id`.
- **Connection:** typed WebSocket member with optional resumable connection state.
- **Caller:** `User`, `System`, or `Anonymous` attribution carried to an actor operation.
- **Principal:** authenticated application subject, available as an option inside actor contexts.
- **ActorError:** the single framework error whose `reason` identifies availability, capacity, timeout, conflict, creation, authorization, input, or transport failure.
- **Hibernation:** removal of activation-local resources while identity and gateway state remain durable.
- **Shard group:** placement choice for compute and data; it is not a tenant database.
- **Conformance harness:** shared behavioral suite run against PGlite, Postgres, and supported Neki configurations.
