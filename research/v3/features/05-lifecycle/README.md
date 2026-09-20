# 05 — Live activations and versioned read models

**Status:** accepted product capability; exact hook names and caching policy are proposals.

[Index](../../README.md) · [Context](../01-actor-context/README.md) · [Background work](../07-background-work/README.md) · [Hibernation](../12-connection-hibernation/README.md)

## Separate lifetimes

```diagram
Actor identity:  ────────────────────────────────────────────
Activation:     [ awake: resources + read models ]   [ awake ]
Command turns:     [tx]   [tx]        [tx]              [tx]
Gateway socket: ────────────────────────────────────────────
Durable job:              [ may continue through sleep ]
```

Identity survives passivation. An activation is a disposable live process-local instance. A turn is a short database transaction. The gateway may hold a connection while the activation sleeps. A durable activity's progress cannot depend on keeping either alive.

## Proposed declaration

```ts
const Chat = Actor.define({
  name: "chat",
  tables: { messages },
  commands: chatCommands,
  lifecycle: {
    hibernateAfter: "30 seconds",
    onActivate: Effect.gen(function* () {
      const ctx = yield* Context
      // Scope is cancelled when this activation ends.
      yield* ctx.supervise(observeExternalPresenceHints(ctx.address))
    }),
  },
  readModels: {
    recentMessages: {
      load: Effect.gen(function* () {
        const ctx = yield* Context
        return yield* ctx.database.select().from(messages)
          .orderBy(desc(messages.sentAt), desc(messages.id)).limit(100)
      }),
      invalidate: "onActorCommit",
    },
  },
})
```

`observeExternalPresenceHints` is an application placeholder, not a durable task. It must use resource-safe Effect services and cooperative interruption. Hook context has no turn-bound writer; any persistent change is submitted as a command.

## Read-model contract

- Cache is derived from committed SQL state and carries actor version/lineage.
- Loading rows and their version must be consistent; tagging old rows with a newer version is incorrect.
- Update/invalidate only after confirmed commit; a rollback must not change the externally visible cache.
- Cache loss is safe. Rebuild from storage after activation restart.
- A read requiring a minimum version must refresh/wait/fail, not serve an older cache as current.
- Invalidation follows every supported write path, including privileged transfer and repair operations.
- Cross-actor SQL is not magically covered by one actor's cache version. Use live SQL or a separately defined dependency model.

```ts
// Actor query context. Optional freshness requirement is explicit.
const ctx = yield* Context
const snapshot = yield* ctx.readModels.get("recentMessages", {
  afterVersion: input.afterVersion,
})
return snapshot
```

Start with invalidation and reload. Incrementally updating a cache from events is an optimization that must prove equivalence, including replay and lost notifications. No mandatory shared Redis-like cache tier is proposed.

## Lifecycle and resource contract

Acquire/release application resources through Effect scopes. Normal passivation runs cleanup best-effort; process death does not guarantee finalizers run. Database fences and persisted state provide correctness independently of cleanup.

Do not retain a database transaction for a connection, timer callback, or running model call. A promise/fiber in memory is not a durable workflow. Live resources that cannot be reconstructed may prevent graceful hibernation until released; they do not justify checkpointing arbitrary JavaScript stacks.

Set bounds for resident actors, read-model bytes, idle time, background fibers and warm-up work. A cold-start wave can overload Postgres; admission and staggered loads matter. Exact limits and tuning defaults require measurements rather than historical guesses.

## Validation gates

1. Update state then fail commit; cached query still returns the prior committed version.
2. Race cache load with a write; row content and reported version match one valid boundary.
3. Drop invalidation hints; version checks/durable catch-up prevent stale-as-current reads.
4. Kill a runner without finalizers; replacement activation rebuilds correctly and old writer is fenced.
5. Attempt mutation through a captured turn handle in background work; reject use after scope expiry.
6. Hibernate with a gateway socket and long job active; only activation-local resources disappear.
7. Cold-start many actors and fill caches; bounded admission/memory and visible degraded latency, not unlimited growth.

Open: exact cache API, version granularity, hook delivery semantics and resident limits. See [hibernation](../12-connection-hibernation/README.md) for connection-specific behavior.
