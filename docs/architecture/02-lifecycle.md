# Actor lifecycle

**Responsibility:** describe identity, activation, turns, and passivation.  
**Authority:** design.  
**Owner role:** runtime.
**Change policy:** a change that alters a contract guarantee requires an ADR.

An actor has a durable identity and a disposable activation. `Actor.make` supports named ids, framework-minted ids, and `singleton: true`; durability follows declared members rather than a separate actor kind. All three modes are implemented: minted ids brand UUIDv7s through `X.id` and `Actors.mint(X)`, singletons register through `Sharding.registerSingleton`, and `create` is restricted to minted actors in types and at runtime. On the embedded `SingleRunner`, singleton registration only owns entity startup on one shard; multi-runner residency and migration are not claimed.

Even an actor without state, tables, events, effects, or blobs has fenced, receipted commands. Acquiring a handle writes nothing; the first turn establishes durable rows. `Lifecycle.createdBy(Command)` can require an explicit creating command before other commands are accepted — implemented as a `created` flag on the generation row, checked after receipt lookup under the fence and set atomically with the first successful creating command. Rows predating the policy read `created = false`, so applying it to existing data requires an application backfill migration.

Wake creates an activation `Scope`, initializes `vars`, resumes parked connections, and forks the optional `run` fiber. `Hibernate.after` ends the scope after idleness — currently realized as the entity `maxIdleTime` policy; `vars`, parked connections, and `run` are not implemented yet. Sleeping interrupts `run` and releases process-local resources without deleting receipts, state, events, timers, workflows, or business rows. `Connections.park` allows this while sockets remain open at the edge.

`run` is scoped background work with an `Effect<void, never, R>` result. It does not keep the actor awake. Expected failures are handled explicitly; a blanket cause-swallowing handler must not disguise a failed loop as completed work. Parking restarts the loop on the next wake, and transport-process loss still requires client reconnection. `run` loops and cron are M2 scope and are not implemented.

Each command is a serialized, fenced turn. The runtime locks the generation, checks the receipt, decodes keyed state through the `Actor.migration` upcast chain, runs the handler, and commits state, table changes, events, intents, effects, and the receipt together. Queries read committed state and rows without an activation transaction. The implemented slice covers state and receipts only — the migration chain, events, intents, and effects are M1 members — and bounds each turn by `Commands.timeout`/`Commands.lockWait` and each mailbox by `Mailbox.capacity`.

Retryable runtime failures are defects that cause redelivery and activation restart. A deterministic defect rolls back, invokes `onDefect` with a read-only context, and returns a `Die` to the caller while the activation remains resident. The hook's `state` is a lazy read that may itself die on corrupt data, so the hook still runs; its own failure reports an `AggregateError` preserving the original cause, and no receipt is written.

Workflows are actor members. Outside a turn, `x.W.start(input, { key })` returns a run handle and `x.W.run(key)` rehydrates it. Inside a turn, `ctx.self.W.start` and `.cancel` are commit-bound intents. The execution key is `[deployment, tenant, actor, id, workflow, key]`.

Cron is a lifecycle policy: `Cron.every(expr, Cmd, { skipIfOlderThan })`. It is a per-actor timer for named or minted actors and cluster-wide for a singleton. See [dispatch](04-dispatch.md).
