# Glossary

These are the 0.2 terms. They describe the contract target; a term is not evidence that its milestone or production-provider gate has passed.

## Identity and authority

- **Store:** one bucket or prefix containing all actor durable bytes, including log, checkpoints, pages, indexes, leases, and audits.
- **Actor:** an addressable contract and durable state, not a resident process.
- **Tenant:** an authenticated application partition; general served tenant addresses remain incomplete and the server currently accepts `default` only.
- **Shard:** a fixed partition of the store whose log groups many actors.
- **Owner:** the runner holding the newest valid open epoch, not merely an advisory lock.
- **Epoch:** the offset of the create-once open segment that fences prior writers.
- **Release:** one application build running against an existing store.
- **Build:** bundle/framework/runtime/engine/platform and locale-version identity recorded with a segment.
- **Activation:** disposable resident actor state; never authority.

## Durable storage

- **Segment:** an immutable, create-once batch in a gapless shard log.
- **Durable prefix:** the stored segment chain from which observable results derive.
- **Speculative state:** results not yet in that prefix; never published.
- **Checkpoint:** a manifest covering state and obligations at one durable offset.
- **Manifest:** encoded state and references to page-tree roots.
- **Page:** SHA-256-addressed bytes, verified on every read.
- **Ambiguous append:** a lost write response resolved by segment identity rather than guessing.
- **Retention:** time for which segments/checkpoints stay recoverable; framework default seven days.
- **GC:** fenced collection of unreachable pages after the grace period.
- **Fork:** separately authorized branch from an actor's retained history, with new actor/work identities; E6 supplies the guarantee.

## Application surface

- **State:** a schema struct decoded from `{}` with defaults, optional fields, or list fields; non-list bytes are capped at 256 KiB.
- **Action:** synchronous deterministic draft mutation with a recorded outcome.
- **Draft:** copy-on-write state and staged consequences discarded as one unit on failure.
- **List:** `Actor.list(Item, { key?, by })`, with items in ordered pages.
- **View:** optional synchronous derived read of durable state.
- **Event:** a live, non-persisted value; action publication waits for durability.
- **Presence:** contract schema plus `connect`/`disconnect` and scoped client `join`.
- **Session:** authenticated transport lifetime at `/rpc`.
- **Job:** Effect I/O started durably by an action and journaled on the shard.
- **Step:** named journaled success that never runs again once durable.
- **Send:** staged fire-and-forget action call to another actor.
- **Timer:** staged action call to the same actor at a recorded due time.
- **Cron:** an action option arming each instance's recurring timer.
- **Index:** owner-held durable scalar-state query structures, persisted at checkpoints.
- **Find:** static `X.find` returning ids only, merged across shards without a global snapshot.
- **Client:** scoped `X.client(id)` with Effect actions and Stream reads; one flat handle.
- **Operator:** separate scoped grant holder, never an application `Caller`.
- **Audit:** metadata recorded before operator read answers or atomically with mutations.

## Recovery

- **Stored outcome replay:** answering a duplicate command without rerunning its handler.
- **Log replay:** applying retained entries to reconstruct and compare outcomes.
- **Build-matched replay:** recovering a tail using the build that wrote it.
- **Released:** final durable handoff record after bounded drain.
- **`nextDue`:** earliest pending due time reported for host wake scheduling.
- **Page miss:** internal pause/load/rerun with identical recorded action inputs.

The [contracts](contracts/README.md) define the exact obligations and their promotion status.
