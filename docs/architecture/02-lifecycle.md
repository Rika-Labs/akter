# Actor lifecycle

**Responsibility:** describe identity, activation, turns, and passivation.  
**Authority:** design.  
**Owner role:** runtime.
**Change policy:** a change that alters a contract guarantee requires an ADR.

An actor has a durable identity and a disposable activation. `Actor.make` supports named ids, framework-minted ids, and `singleton: true`; durability follows declared members rather than a separate actor kind.

Wake creates an activation `Scope`, initializes `vars`, resumes parked connections, and forks the optional `run` fiber. `Hibernate.after` ends the scope after idleness. Sleeping interrupts `run` and releases process-local resources without deleting receipts, state, events, timers, workflows, or business rows. `Connections.park` allows this while sockets remain open at the edge.

Each command is a serialized, fenced turn. The runtime locks the generation, checks the receipt, decodes keyed state through the `Actor.migration` upcast chain, runs the handler, and commits state, table changes, events, intents, effects, and the receipt together. Queries read committed state and rows without an activation transaction.

Retryable runtime failures are defects that cause redelivery and activation restart. A deterministic defect rolls back, invokes `onDefect` with a read-only context, and returns a `Die` to the caller while the activation remains resident.

Workflows are actor members. Outside a turn, `x.W.start(input, { key })` returns a run handle and `x.W.run(key)` rehydrates it. Inside a turn, `ctx.self.W.start` and `.cancel` are commit-bound intents. The execution key is `[deployment, tenant, actor, id, workflow, key]`.

Cron is a lifecycle policy: `Cron.every(expr, Cmd, { skipIfOlderThan })`. It is a per-actor timer for named or minted actors and cluster-wide for a singleton. See [dispatch](04-dispatch.md).
