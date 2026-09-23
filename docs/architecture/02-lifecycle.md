# Actor lifecycle

**Responsibility:** describe identity, activation, turns, and passivation.  
**Authority:** design.  
**Owner role:** runtime.
**Change policy:** a change that alters a contract guarantee requires an ADR.

An actor has a durable identity and a disposable activation. `Actor.make`'s `key` section selects named ids, framework-minted ids (key omitted), or `Actor.singleton`; durability follows declared sections rather than a separate actor kind ([ADR 0010](../decisions/0010-one-way-effect-native-api.md); the implemented M0 code still uses `id`/`singleton: true` options). All three modes are implemented: minted ids brand UUIDv7s through `X.id` and `Actors.mint(X)`, singletons register through `Sharding.registerSingleton`, and `create` is restricted to minted actors in types and at runtime. On the embedded `SingleRunner`, singleton registration only owns entity startup on one shard; multi-runner residency and migration are not claimed.

Even an actor without state, tables, events, effects, or blobs has fenced, receipted commands. Acquiring a handle writes nothing; the first turn establishes durable rows. `policy.createdBy` can require an explicit creating command before other commands are accepted — implemented as a `created` flag on the generation row, checked after receipt lookup under the fence and set atomically with the first successful creating command. Rows predating the policy read `created = false`, so applying it to existing data requires an application backfill migration.

Wake creates an activation `Scope` and runs the layer's build Effect, which acquires activation-local values (such as a `Ref`) and may fork background fibers with `Effect.forkScoped`; parked connections resume. `policy.hibernateAfter` ends the scope after idleness, currently realized as the entity `maxIdleTime` policy; parked connections and background loops are not implemented yet. Sleeping runs `Effect.addFinalizer` finalizers, interrupts forked fibers, and releases process-local resources without deleting receipts, state, events, timers, workflows, or business rows. Parked connections allow this while sockets remain open at the edge.

A singleton's background loop is a fiber forked in its build with `Effect.forkScoped`. It does not keep the actor awake. Expected failures are handled explicitly; a blanket cause-swallowing handler must not disguise a failed loop as completed work. Parking restarts the loop on the next wake, and transport-process loss still requires client reconnection. Background loops and cron are M2 scope and are not implemented.

Each command is a serialized, fenced turn. The runtime locks the generation, checks the receipt, decodes keyed state through its migration chain (or reuses the activation's cached state), runs the handler, and commits state, table changes, events, intents, effects, and the receipt together. Queries read committed state and rows without an activation transaction. The implemented slice covers state and receipts only — the migration chain, events, intents, and effects are M1 members — and bounds each turn by `policy.commandTimeout`/`policy.lockWait` and each mailbox by `policy.mailboxCapacity`.

Retryable runtime failures are defects that cause redelivery and activation restart. A deterministic defect rolls back, records its cause in the turn span and log, and returns a `Die` to the caller while the activation remains resident; no receipt is written. The M0 code still runs an `onDefect` hook ([ADR 0008](../decisions/0008-foundation-completion.md)); the target has none ([ADR 0012](../decisions/0012-workflows-internals-effects-defects-merging-regions.md)).

Workflows are actor members in `api`. Outside a turn, calling the workflow on a handle returns a `WorkflowRun`. Inside a turn, `X.intents(id)` starts it as an outbox intent. The execution key is `[deployment, tenant, actor, id, workflow, key]`.

Cron is `policy.cron`, mapping expressions to zero-input commands. It is a per-actor outbox timer for named or minted actors and cluster-wide for a singleton. See [dispatch](04-dispatch.md).
