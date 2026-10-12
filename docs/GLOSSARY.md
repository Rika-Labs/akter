# Glossary

**Responsibility:** keep vocabulary consistent across agents and packages.  
**Authority:** normative terminology; on `rewrite/0.2` it defines the 0.2 vocabulary of [ADRs 0124–0137](decisions/README.md#02-rewrite-proposed).  
**Owner role:** product/runtime architecture.
**Change policy:** a term change requires a consistency pass over every document that uses it.

## Identity and placement

- **Store:** the durable home of one application's actors: one bucket (or bucket prefix) holding the log, checkpoints, pages, index, GC and runner leases, described once by `meta/store`. In Akter Cloud, one store per environment incarnation. Replaces the 0.1 "deployment" in every storage role.
- **Tenant:** the application's own partition, set only by the transport, `"default"` for in-process code. Part of every actor address; never part of an object key or shard id.
- **Actor:** a durable identity with state, lists and actions; its state is rebuilt from the newest checkpoint plus later log entries.
- **Actor address:** `(tenant, type, id)` inside one store.
- **Activation:** the disposable in-memory form of an actor on its shard owner. It holds durable and speculative state; neither memory copy is authority.
- **Shard:** one of the store's `shards` partitions (default 16, fixed in `meta/store`); an actor's shard is `hash(tenant, type, id) mod shards`. A shard mixes tenants and types.
- **Shard owner:** the runner whose `Open` segment is the newest in the shard's log and whose validity has not lapsed.
- **Epoch:** the offset of the owner's `Open` segment; it identifies one ownership of a shard. There is no separate counter.
- **Release:** one build of the application running against a store (Akter Cloud calls it a deployment). Not part of any storage key.
- **Build:** the identity recorded on every segment: application bundle digest, framework version, JavaScript engine and version.
- **Runner:** one process serving a store; it may own shards and gateways calls to other owners.
- **Environment / environment incarnation:** Akter Cloud's isolation and lifecycle unit; a recreated environment with the same name is a new incarnation with a new store.
- **Environment storage retirement:** Akter Cloud's deletion of a deleted environment's store: revoke credentials, wait 30 days, empty and delete the bucket.

## The log

- **Log:** a shard's ordered, gapless chain of segments in the store's bucket; the source of truth.
- **Segment:** one immutable object `s/<nn>/log/<offset>` holding one group-committed batch, created once with `If-None-Match: *`. Its header names the writer, the epoch and the build.
- **Open segment:** the segment holding an `Open` entry, created by a new owner at the head plus one; its offset is the epoch.
- **Offset:** a segment's position in its shard's log.
- **Batch:** the entries one append makes durable together.
- **Group commit:** per-shard batching where the next append starts when the previous returns and takes everything queued.
- **Durable prefix:** the segments that exist in the bucket. Everything observable derives from it.
- **Durable state:** the state produced by the durable prefix; the only state views, streams and the index read.
- **Speculative state:** the result of actions whose segment is not yet durable; used to run later actions on the owner, never published.
- **Durability acknowledgement:** the reply to an action, sent only after its segment is durable.
- **Ambiguous append:** an append whose response was lost; resolved by reading the segment header (ours or not), never by guessing.
- **`T_valid`:** 10 seconds; an owner that has neither appended nor verified within it verifies before serving.
- **`T_trim`:** 10 minutes; trim removes only segments covered by a checkpoint at least this old.
- **Checkpoint:** an immutable manifest `s/<nn>/cp/<inverted offset>` covering a shard's actors, timers, pending sends, jobs, deduplication state, connections and index at one offset.
- **Archive before trim:** holds by construction: segments are the history archive and are trimmed only after retention.
- **Checkpoint pointer:** none exists: the newest checkpoint is the first key of an ascending list of inverted offsets.
- **Manifest:** an immutable page naming other pages: an actor manifest (state plus list roots) or a checkpoint manifest.
- **Page:** an immutable, content-addressed object `pages/<sha256>` of about 64 KiB, verified against its key on every read.
- **Page key / digest:** the SHA-256 of a page's bytes; its object key.
- **`PageMiss`:** the internal signal that an action touched a list page not in memory; the runtime loads it and reruns the action. Never published.
- **Replay the log:** rebuild state by applying entries after a checkpoint, verifying each recorded outcome.
- **Replay a stored outcome:** answer a retried command id with its recorded outcome without running anything. Not the same operation as replaying the log.
- **Build-matched replay:** replaying a tail with the build that wrote it.
- **Release handoff:** a drained owner appends `Released`; another release opens the shard only after that or after the owner's lease expires.

## Contract and execution

- **Contract:** the value `Actor.make` returns, shared with clients: key, state, actions and the optional views, events, jobs, presence and access.
- **State:** a `Schema.Struct` whose fields all have decoding defaults or are lists; at most 256 KiB without lists.
- **List:** a state field declared with `Actor.list(Item, { key?, by })` whose items live in page trees; unbounded.
- **Action:** a synchronous, deterministic handler `(draft, payload, ctx) => void | Fails | Success` declared with `Actor.action`.
- **Draft:** the copy-on-write view of state an action changes; discarded with every staged effect on failure.
- **Action context (`ctx`):** the only capabilities of an action: `caller`, `now()`, `id()`, `random()`, `self`, `send`, `schedule`, `start`, `emit`, `connection`.
- **Admission time:** the owner's clock at admission, clamped to never decrease in a shard, recorded in the entry and returned by `ctx.now()`.
- **Seeded randomness:** `ctx.random()`, a generator seeded from the command id, identical on replay.
- **Staged effect:** a send, timer, job start or event an action stages; durable with the action or discarded with it.
- **Outcome:** an action's recorded result: success value, declared failure or defect.
- **View:** an optional synchronous `(state, params, ctx) => value` derived from durable state, declared with `Actor.view`.
- **Event:** a value declared with `Actor.event`, emitted by an action (published after durability) or a job (published at once); never stored.
- **Presence:** an optional contract schema that enables `connect`, `disconnect` and `handle.join`.
- **Session:** a client's WebSocket to `/rpc`, bound to one caller at open and reauthorized every `reauthorizeEvery`.
- **Connection:** one `join` on one actor, identified by a runtime-minted connection id.
- **Send:** a one-way action staged with `ctx.send`, delivered exactly once after the sender is durable.
- **Timer:** a one-shot action staged with `ctx.schedule`, kept on the shard's timer wheel.
- **Timer wheel:** the shard's pending timers and cron ticks, part of every checkpoint.
- **`nextDue`:** the earliest due instant of a shard, recorded in every checkpoint and the drain report.
- **Cron:** the `cron` option of an action that makes it recurring.
- **Job:** the only place for I/O: an Effect declared with `Actor.job` and implemented in `toLayer`, started by an action, journaled on its shard.
- **Step:** a named unit of a job whose result is journaled so it never runs again once finished.
- **Journal:** a job's `JobStarted`, `JobStep` and `JobFinished` entries in its shard's log.
- **Job failure route:** the required `onFailure` action that receives `Actor.JobFailure` after retries are spent.
- **Index:** the owner-held, per-shard index of every top-level scalar state field, persisted as pages at checkpoint.
- **Index freshness:** each shard's index reflects exactly its durable prefix; there is no consumer, progress table or lag token.
- **`find`:** `X.find({ where, orderBy, limit })`, a tenant-scoped query answered by every shard owner and merged.
- **Fork:** a new actor created by an operator from another actor's retained history, sharing its pages.
- **History retention:** how long a store keeps segments and checkpoints (default 7 days; Cloud: 7 Free, 30 paid).
- **History position:** an actor version (count of applied actions) or an instant, resolved to `(shard, offset, entry index)`.
- **Root reachability:** what GC protects: everything reachable from retained checkpoints.
- **Garbage collection:** lease-holding mark and sweep that deletes unreachable pages older than the grace period.

## Identity, callers and errors

- **Command ID:** an action's retry identity. External ids are client-minted `v1.<issuedAtMs>.<expiresAtMs>.<uuidv4>`; derived ids are UUIDv8 computed from a parent id and an ordinal.
- **Derived command ID:** the id of a send, timer firing, job call or `ctx.id()` value; reproducible on replay and never accepted from a client.
- **Deduplication:** a repeated id runs at most once: client ids in shard-level buckets until expiry, sends by per-stream watermarks, job calls until the job call window.
- **Caller:** `User { subject } | Anonymous | System { source, ref?, onBehalfOf? }`; no roles.
- **Access:** the contract's optional `(caller, request) => boolean`; default allows `User` and `System`.
- **ActorError:** the single framework error; its `reason` is one of the reasons in the [error model](contracts/error-model.md).
- **Defect:** an unrecoverable action failure (`SynchronousActionViolation`, `StateTooLarge`, `ReplayMismatch`, `PageCorrupt`, decode failure); recorded, never wrapped as `ActorError`.
- **Operator:** a separate principal with capability grants, audited on every read and mutation.
- **Simulation:** the seeded, fault-injecting runner of `@rikalabs/akter/testing` that checks invariants against independent expectations.

## Retired terms

These 0.1 terms no longer name anything in the 0.2 public model. Use the replacement.

| Retired term                                                       | Replacement                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Turn, command turn                                                 | Action execution; synchronous, not a database transaction                      |
| Turn batch                                                         | Group-commit batch per shard                                                   |
| Receipt                                                            | Stored outcome in the deduplication state                                      |
| Receipt horizon, `keepReceipts`                                    | Command-id expiry and deduplication buckets                                    |
| Generation, generation row                                         | Epoch (the open segment's offset)                                              |
| Intent, `X.intents`                                                | `ctx.send`, `ctx.schedule`, `ctx.start`                                        |
| Outbox, relay                                                      | Internal pending sends of a shard; no public primitive                         |
| Handle, `X.get`                                                    | `X.client(id)`                                                                 |
| Mint, `turn.mint`, `X.create`, `createdBy`                         | `ctx.id()` plus a send; actors exist once they have a durable action           |
| Singleton (`Actor.singleton`)                                      | A well-known actor id                                                          |
| Reducer                                                            | Action                                                                         |
| Query, watch query, `X.toQueryLayer`                               | State, list and view streams                                                   |
| Feed, stream member, event cursor                                  | Events (not stored) and state streams                                          |
| Connection member, holder, parking                                 | Presence (`join`, `connect`, `disconnect`)                                     |
| Fleet view, `Fleet.view`                                           | `find` over the owner-held index                                               |
| Query tier                                                         | `find` and actor reads                                                         |
| Owned table, `Actor.table`                                         | List                                                                           |
| Adoption                                                           | Removed; no replacement                                                        |
| Blob, `Actor.blob`                                                 | List items holding bytes                                                       |
| Content, `Actor.content`                                           | Content-addressed pages, an engine detail                                      |
| Placement, placement key, parent placement                         | Shard by address; no API                                                       |
| Routing key                                                        | Actor address and shard number                                                 |
| Home region, tenant directory                                      | One region per store                                                           |
| Cold tier                                                          | Every actor is snapshotted to pages                                            |
| Workflow, `Actor.workflow`, `WorkflowRun`                          | Job                                                                            |
| Executor, `X.toJobLayer`, `X.Executor`                             | Job handler in `X.toLayer`                                                     |
| Version marker, `wf.version`                                       | Step names and build-matched replay                                            |
| Dead letter, `onDeadLetter`, `onSuccess`                           | `onFailure` with `Actor.JobFailure`; success flows through the job's own calls |
| `onCancelled`, `cancelJob`                                         | Removed in 0.2.0                                                               |
| Internal command, `internal` section                               | System-only actions (`cron` and `onFailure` targets) and `access`              |
| Subscription, `Actor.subscription`                                 | `ctx.send` from the source action                                              |
| Context service (`X.Turn`, `X.Read`, `X.Connection`, `X.Workflow`) | The action context `ctx` and the job context                                   |
| Keyed state                                                        | State                                                                          |
| `schedules`, `policy.cron`                                         | The `cron` action option                                                       |
| `ActorTest`                                                        | `Simulation`                                                                   |
| Promise client, `@rikalabs/akter/client`                           | The Effect client                                                              |
| Deployment (as a storage noun)                                     | Store                                                                          |
| Log cluster, log assignment                                        | None; the bucket is the log                                                    |
| Conformance harness (0.1 suites)                                   | Simulator plus bucket-protocol suites                                          |
