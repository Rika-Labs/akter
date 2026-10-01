# ADR 0055: Query observation: `watch` on supported scoped queries

**Status:** accepted (2026-09-30, Dallen; proposed 2026-09-29). It gates M6.2 ([#299](https://github.com/Rika-Labs/akter/issues/299) drafts it). It is the second item of [ADR 0014](0014-adoption-observation-and-client-reach.md)'s order and needs no migration. When accepted it amends [contract 07](../contracts/07-realtime.md), [protocol](../contracts/protocol.md), [ADR 0027](0027-served-protocol.md) sections 1, 6, and 7, the [server API](../api/01-server-api.md), the [TypeScript SDK](../api/03-typescript-sdk.md), and the [post-foundation sketch](../api/post-foundation-sketches.md).

**Responsibility:** decide which queries can be watched, how the runtime learns that a committed write may have changed a watched result, what a subscriber receives, and what the runtime refuses instead of pretending to be live.

**Authority:** design decision record.

**Owner role:** realtime/runtime.

**Change policy:** supersede through a new ADR.

## Context

ADR 0014 promises that "a declared, supported query algebra may produce invalidation notifications and rerun results after committed writes," and that the framework will not promise arbitrary live SQL. The sketch is `for await (const page of room.Recent.watch({ limit: 50 })) render(page)`. The code today gives these facts:

- **A query is an opaque Effect.** `Actor.query` ([`members/command.ts`](../../packages/akter/src/members/command.ts)) declares only a tag, an input, an output, and errors. Its handler, written with `X.toQueryLayer`, is an Effect with `R | Read`. `R` is whatever services the layer was built with, so a query can call another service, read the clock, or read another actor's data through the `Database` tag, and the runtime cannot see what it read.
- **The query path reads committed rows and nothing else.** `query` in [`runtime/layer.ts`](../../packages/akter/src/runtime/layer.ts) needs no activation, fence, receipt, or command id. It reads the event head and state in one statement, so state and events describe one moment, and replays events only up to that head. Owned rows and blobs are read in later statements through the primary's pools. It can read a streaming replica after checking `durable-min-version` ([ADR 0052](0052-read-your-writes-commit-versions.md)), and it falls through to the primary otherwise. It calls `authorize` with `kind: "query"` before and after the read.
- **`X.Read` is a closed set of capabilities:** `state`, `cursor`, `events`, `rows`, `group`, `blob`, plus identity (`id`, `ref`, `caller`, `principal`). `follow` and `progress` need `InStream`, so a query cannot use them.
- **Only turns change actor data.** Contract 06 and invariant A3 allow state, events, rows, and blobs to change only in a turn's transaction. A turn already stages its state writes, its events (`eventsStatement`), and its blob writes, and `ScopedRows` mutations pass through the runtime ([`turn/rows.ts`](../../packages/akter/src/runtime/turn/rows.ts)). One framework path also changes what a query can see outside a turn: retention pruning of events ([`storage/retention.ts`](../../packages/akter/src/runtime/storage/retention.ts)). The cold tier's rehydration changes nothing visible.
- **The only commit signal today moves with events.** `advance` in [`connections/owner.ts`](../../packages/akter/src/runtime/connections/owner.ts) completes a deferred when an activation's event head moves, and `read.follow` and event feeds wait on it. A turn that changes state, rows, or a blob without emitting moves no head. There is no per-actor commit counter, and `0019_commit_version` is unused ([ADR 0052](0052-read-your-writes-commit-versions.md)).
- **The realtime machinery is parked connections and best-effort broadcasts.** An event feed is a framework connection with no application handler, stored in `actor_connections`, parked, held by the runner serving the SSE response, and told about each commit by a post-commit broadcast the owner sends ([ADR 0027](0027-served-protocol.md) section 7, [ADR 0023](0023-connections-parking-and-streams.md)). A broadcast is never durable. After a gap or an ungraceful owner death the holder resynchronizes by itself. A turn's commit version (ADR 0052) is already in the turn's result (`Executed.version`).

So a watch cannot be defined over "a query" as the runtime knows it. It needs a query the runtime can prove reads only what a commit signal covers.

## Decision

### 1. A member opts in with `watch: true`

```ts
const Recent = Actor.query("Recent", {
  input: Schema.Struct({ limit: Schema.Int }),
  output: Schema.Array(Message),
  watch: true,
})
```

- **Only a member declaring `watch: true` can be watched.** Every other query answers a watch request `400 InvalidInput { code: "not_watchable" }`, so a query is never treated as live by accident. The declaration is in the contract, so OpenAPI, clients, and `Actor.serve` agree on which members can be watched.
- **The handler's type allows only `Read`.** `QueryHandlers` types a watchable member's handler as `(input) => Effect<Output, Errors, Read>`, so a handler that needs another service does not compile. At runtime a watch's reruns provide only `Read` and the framework services it needs, so a handler that got around the types fails with a defect on its first rerun instead of running unwatched.
- **Reads are recorded, per rerun.** The runtime hands the handler a recording `Read`. It notes which of these the handler touched: `state` (any access to `state` counts as all keyed state), `events(E)` for each event class, `rows(T)` for each declared table, and `blob(B)` for each declared blob. Recording is per rerun, so a handler that branches on state reads what it reads that time. Reading `caller`, `principal`, `id`, or `ref` is recorded too and makes the result caller-dependent (section 5).
- **The algebra is deliberately small.** The supported set is exactly the four capabilities above, over this actor's own committed data, with `ScopedRead`'s existing filter, order, and limit algebra inside `rows`. If a rerun records `group`, a service call the recorder can see, or a table adopted under [ADR 0054](0054-existing-schema-adoption.md) that is not enforced with an empty allow list (its legacy or allowed writers change rows outside turns, which no turn's frame reports), the watch ends with `InvalidInput { code: "not_watchable" }` and a message naming the read. It does not degrade to polling silently.
- **What the recorder cannot see is documented, not policed.** A handler is a function of its input and committed data. One that reads the clock or a random source gets a result as of its rerun and no invalidation for it. Section 4's reconcile rerun bounds the staleness. `docs/api` says this next to `watch`.

### 2. The commit signal: a small frame per committing turn

- **Each committing turn records what it wrote:** `{ state: boolean, events: tags, tables, blobs }`. This is bookkeeping over paths the turn already owns (its state write, its `eventsStatement`, `ScopedRows` mutations, its blob writes), and adds no statement.
- **The owner broadcasts one `Committed { version, writes }` frame per turn, after commit,** to the holders of watches on that actor, through the same post-commit path event feeds use, with `version` from `Executed.version`. Types that declare a watchable query pay what types with feeds pay: one more pipelined statement in a cold activation's admission round trip for the connection rows, and the `Begin` wait ([ADR 0027](0027-served-protocol.md) section 7, item 5). Types with none pay nothing.
- **The holder intersects, the owner does not.** A holder keeps each watch's last recorded read set and reruns a watch only when the frame's writes intersect it. Precision is an optimization: an extra rerun is harmless because identical results are suppressed (section 3). A missed invalidation is the failure, and section 4 exists to catch it.
- **A watch is a parked connection with no handler,** like a feed. It lives in `actor_connections` with the framework member `$watch:<Query>` beside the feed's `$feed`, holds no activation resident, and wakes the actor only as any open does. So M6.2 needs no migration.

### 3. Reruns: coalesced, monotonic, and quiet when nothing changed

- **A rerun is the query path.** The holder calls `query` with `durable-min-version` set to the greatest version it has seen for this watch. So the rerun reflects at least the commit that invalidated it, a replica answers only once it has replayed that commit, and it falls through to the primary otherwise ([ADR 0052](0052-read-your-writes-commit-versions.md)). "Consistent" here means what a query already means: state and events from one moment, rows and blobs read after them. A result never reflects an older version than an earlier result of the same watch.
- **At most one rerun runs per watch, and one waits.** Frames that arrive during a rerun only raise the pending version. A watch reruns at most once per `minInterval`. Intermediate states are therefore skipped, which the docs state: **a watch is not an event history.** A caller that needs every change follows events (`read.follow`, an event feed).
- **A result identical to the last one sent is not sent.** The runtime compares the encoded output bytes.
- **The latest result wins.** A consumer that reads slower than results arrive gets the newest one. Nothing is queued, and a watch never ends with `SlowConsumer`, unlike a stream, because dropping a state the next one replaces loses nothing.

### 4. A missed frame is not a missed change: the reconcile rerun

The broadcast is best-effort ([contract 07](../contracts/07-realtime.md)), and retention pruning changes `events(E)` results with no turn. So a watch also reruns:

- on a holder's resync after a broadcast gap or an ungraceful owner death (ADR 0023 section 7's paths), and
- every `reconcileEvery` (default 30 s) whether or not a frame arrived.

That is [ADR 0006](0006-scale-rules-placement-and-query-tiers.md)'s rule for wakeups, "durable polling as the correctness path," applied to reads. Its cost is one rerun per open watch every `reconcileEvery`. A per-actor commit counter would make that a one-row read, but it needs a migration and a write in every turn, so this ADR does not add it (Q3).

### 5. Wire form and clients

- **Route.** `POST /actors/{Actor}/{id}/{Query}/watch` with the query's input as the body, answering `text/event-stream`, in [ADR 0027](0027-served-protocol.md) section 1's table beside the stream route. A sub-path, not an `accept` header on the query route, because one route then answers exactly one media type, OpenAPI stays one operation per response, and `authorize` sees a distinct kind.
- **Framing.** Each result is `event: result` with the encoded output as `data`. Its `id` is the version the rerun waited for, when there is one. The first result is sent right after the watch opens and has no `id` unless the request carried `durable-min-version`. The stream ends with `end` carrying the declared error or `SessionEnded`, as streams do. There is no `Last-Event-ID` resume, because a watch is state, not history: a reconnect opens a new watch and its first result is the current state.
- **OpenAPI** lists the operation as `durable.<Actor>.<Query>.watch` with `x-durable-transport: "sse"` and the query's output as the element schema.
- **Promise client:** `room.Recent.watch(input, options?)` returns an `AsyncIterable` of outputs, reconnecting with its last token like a feed, and ending with the typed error the server sent. **In-process handle:** `handle.Recent.watch(input)` returns a `Stream<Output, ActorError>`. Both exist only on members declared `watch: true`.
- **Authorization.** The `authorize` hook gets a new `kind: "watch"` with `command` the query tag, before anything is read, and `kind: "reauthorize"` with `of: "watch"` every `policy.reauthorizeEvery` (contract 07's revocation bound). A watch ends with `Unauthorized { code: "expired" }` at its credential's `expiresAt`, as a feed does. Reruns use the caller stored at open and do not call the hook per rerun, which would multiply authorization load by the fan-out. A result is never released to a caller whose bound has passed.
- **Tenant.** Reruns run with the actor's tenant. With [row-level security](0051-row-level-security.md) on, they run as the role with `durable.tenant` set, on whichever server answers.
- **Identical results are not shared.** Each watch reruns for itself (Q4).

### 6. Limits

- **Per actor:** at most 1,000 open watches, counted separately from feeds and streams. A further one is `503 RunnerAtCapacity`.
- **Per runner:** at most 64 reruns in flight (a rerun beyond that waits, and the newest pending version wins), and `minInterval` of 100 ms between reruns of one watch.
- **Group and fleet queries are not watchable.** A `group` read has no commit signal: every actor in the placement group could invalidate it, so each commit would notify every group watcher. Fleet reads use [ADR 0056](0056-fleet-views.md). The rejection is `not_watchable`, and no polling tier is offered by default (Q5).

## Open questions and recommended defaults

**Q1. Declare `watch: true` on the member, or watch any query the runtime can record?** Default: declare. The declaration puts the restriction in the type (a handler needing another service does not compile), documents it in OpenAPI, and lets an existing query change nothing. Rejected: recording every query and rejecting on first unsupported read, which finds the problem at a subscriber's first rerun instead of the developer's compiler.

**Q2. Which numbers are the defaults?** Default: 1,000 watches per actor, 64 concurrent reruns per runner, `minInterval` 100 ms, `reconcileEvery` 30 s, configured in `policy.watch` (`maxPerActor`, `minInterval`, `reconcileEvery`, with `reconcileEvery` bounded 5 s to 1 h). The fan-out benchmark (T15) may change them before acceptance.

**Q3. Add a per-actor commit counter?** Default: no. It would turn the reconcile rerun into a cheap check, but it needs a migration and one more written column on the hot generation row for every turn, which ADR 0006 discourages (updates that stop HOT). Revisit if reconcile cost dominates.

**Q4. Share one rerun between identical watches?** Default: no. A result may depend on the caller (`Read.caller`), and the runtime can only know it does not when the recorder saw no such read. Sharing is a safe optimization for caller-independent handlers once the fan-out benchmark asks for it. It is not needed for correctness.

**Q5. A polled tier for group queries?** Default: not in M6.2. `watch: { group: { pollEvery } }` would rerun on a timer, claim no invalidation, and label itself as polled. It is cheap to add and easy to mistake for a live query, so it waits for a request that names a use.

**Q6. Rerun in one snapshot?** Default: no. Reads keep the query path's semantics, and a result reflects at least the frame's version. Running the handler in one `REPEATABLE READ READ ONLY` transaction would remove state-then-rows skew at two more statements per rerun (RLS-on queries already run in a transaction, [ADR 0051](0051-row-level-security.md)). Revisit if a caller shows the skew matters.

**Q7. Per-rerun authorization?** Default: no (section 5). The revocation bound already governs every live session in contract 07. Rejected: calling the hook on each rerun, which costs a user hook per result per watcher.

**Q8. Freeze the clock and random source in reruns?** Default: no. It would make a handler that reads time deterministic but never invalidated, which hides the problem. Section 1 documents it, and the reconcile rerun bounds it.

**Q9. Does the client fold result ids into its read-your-writes token?** Default: no. The `id` says "reflects at least this version," which the client already holds if its own commands produced it, and a token another client committed only sends queries to the primary.

## Alternatives

- **Arbitrary live SQL.** Rejected by ADR 0014: no supported dependency tracking, no bounded invalidation cost.
- **`LISTEN`/`NOTIFY` on commit.** Prohibited on the turn path by [ADR 0006](0006-scale-rules-placement-and-query-tiers.md), and not durable.
- **Logical decoding of the actor's rows for actor-local watches.** It sees writes made outside turns, but it needs `wal_level=logical`, cannot run on PGlite, orders nothing across shards, and puts a decoder on every runner. That machinery is justified for fleet views ([ADR 0056](0056-fleet-views.md)), not for one actor's rows, where the turn already knows what it wrote.
- **A stored dependency description (a second, declarative twin of the handler).** Two definitions of one query would drift. Recording the handler's own reads has one.
- **Rerun on every commit with no read set.** Correct, and the fallback if recording proves fragile, but every watcher reruns for every turn of the actor. The read set is the only precision.
- **A commit counter on `actor_generations` (`0019`-style).** See Q3.
- **Long polling.** It is a watch with the coalescing done by the client and every round trip paid again.

## Consequences

- A browser or a service can hold a bounded, typed, live view of one actor without polling, and never receives a query the runtime cannot vouch for. M6.2 adds no mutation primitive and no migration.
- The Statements gate is unchanged for types with no watchable query. Types with one pay the feed cost in a cold activation's admission. A committing turn of such a type sends one small frame per holder with a watch, whether or not any watch reads what it wrote.
- Rerun load scales as watchers × turns, minus suppression and coalescing, plus watchers per `reconcileEvery`. The limits in section 6 bound it, and T15 measures it.
- `authorize` gains `kind: "watch"`. A hook that denies kinds it does not know denies watches until updated, which is the safe failure.
- `docs/api` and the OpenAPI document gain one route and one declaration. `QueryHandlers` gains a per-member requirement, which the type tests cover.
- Watchers see states, never history. That is documented on `watch` and in contract 07's list of realtime surfaces.

## Evidence

`conformance/watch.ts` runs on PGlite and Postgres, with the cases that need independent runners or a real kill marked Postgres-only. Each fails when its mechanism is removed:

- `sends the current result first, then a rerun after a turn that writes state, an emitted event class, a table, or a blob the query read`, one case per capability, so an invalidation dropped for any of them fails (**Query observation: actor-local invalidation is complete**);
- `does not send a result when the rerun is identical, and skips reruns for a turn that wrote nothing the query read`;
- `coalesces commits that land during a rerun into one further rerun, and never sends a result reflecting an older version than an earlier one`;
- `recovers a dropped Committed frame on the reconcile rerun` (a fault at the owner's flush), `recovers a retention prune of a read event class the same way`, and `reruns after an owner killed between commit and flush` (Postgres, real SIGKILL and a second runner);
- `a watch held on runner A sees a turn committed on runner B` (Postgres, multi-runner);
- `rerun waits for the frame's version: a lagging replica is bypassed and the primary answers` (real streaming replica, `TEST_REPLICA_DATABASE_URL`, replay paused as in `read-your-writes.ts`);
- `refuses at open, with not_watchable: a query without watch, and ends a running watch that starts reading group, or a table adopted but not enforced with an empty allow list` (**unsupported SQL is rejected rather than silently treated as live**);
- `denies a watch at open, ends it within reauthorizeEvery after revocation, ends it at credential expiry, and sends no result after the bound`;
- `keeps tenants apart: another tenant's caller cannot open the watch, and with row-level security on reruns run as the role bound to the tenant`;
- `an idle watch does not keep the actor resident and does not count against the stream cap`, and `a further watch past the per-actor cap answers RunnerAtCapacity`;
- `a slow consumer receives the newest result and the watch stays open`.

The type test in `actor/definition.test.ts` shows a `watch: true` handler that requires another service does not compile. The OpenAPI case in `conformance/http.ts` expects `durable.<Actor>.<Query>.watch` with `x-durable-transport: "sse"`. The Query observation check names these. T15 adds a `watch` fan-out scenario: rerun latency and statements per commit at 1, 100, and 1,000 watchers on one actor and across many actors, warm and reported apart from cold, to [performance](../verification/03-performance.md).

## Revisit when

- Reconcile cost dominates rerun cost (Q3).
- Callers show state-and-rows skew (Q6), or identical watchers dominate fan-out (Q4).
- A group-scope watch has a named use (Q5), or Neki needs its own signal because each shard has its own WAL.
- The recorder misses a read that a supported capability makes, which is a bug in this ADR's completeness claim, not a limit.
