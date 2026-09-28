# ADR 0034: Tenant-scoped content-addressed blobs

**Status:** proposed (2026-09-28).

**Responsibility:** decide how identical bytes are stored once per tenant and shared across that tenant's actors: how access is granted, how unreferenced content is collected, where rows live, and how long unreferenced content is kept.

**Authority:** design decision record.

**Owner role:** runtime / security.

**Change policy:** supersede through a new ADR.

## Context

Today every blob belongs to one actor. [Contract 06](../contracts/06-storage-ownership.md) says `actor_blobs` rows carry the actor's `routing_key`, tenant, type, and id, so "equal names in two tenants, two actor types, or two actors never share bytes". `turn.blob` writes in the turn (`get`, `set`, `append`, `compact`), `BlobRead` reads off-turn, each entry is at most 8 MiB (`MAX_ENTRY_BYTES` in `runtime/turn/blobs.ts`, below the driver's 16 MiB message limit), and `policy.maxBlobBytes` (default 64 MiB) caps one actor's entries together.

M4.13 adds shared content ([M4](../milestones/M4.md)). General uses: one uploaded file attached to several documents or messages, and deduplicating identical uploads across a tenant's actors, such as the same logo or invoice template uploaded by many users. M4.md fixes what the ADR must settle:

- **Access.** Knowing a hash never grants a read, just as knowing a command id doesn't grant receipt access ([contract 04](../contracts/04-receipts.md)).
- **Garbage collection** that is safe under concurrent adds and removes.
- **Placement.** Content lives on the tenant's routing key. A turn of an actor-placed actor that also touched it would touch two shards on Neki, which [ADR 0006](0006-scale-rules-placement-and-query-tiers.md)'s single-shard rule forbids on hot paths. Per-tenant reference counts must not become a hot row.
- **Retention** of unreferenced content.

Other constraints:

- ADR 0006 forbids foreign keys from high-volume actor tables to shared low-cardinality parent rows (multixact exhaustion) and global counters touched by every turn.
- Turn transactions on Neki are `tx_mode = 'single'` and `fanout = 'single'`, so a turn cannot read a second shard.
- Research on external blob stores ([v1 blob storage](../../research/v1/source/extracted-package/durable-actors/docs/BLOB_STORAGE.md)) prefers immutable content-addressed objects, uploaded first and then referenced from a turn, with orphans collected after a grace window. The same shape fits a database table.
- [Vision 03](../vision/03-relational-data.md) says external object-storage APIs are not the blob surface. This ADR keeps content in Postgres.

## Decision

### 1. Declaration and the flow

```ts
export const Attachments = Actor.content("attachments")

export const Document = Actor.make("Document", {
  key: DocumentId,
  blobs: [Attachments],
  api: { Attach, Detach },
})

// 1. Outside any turn: upload the bytes once and get a reference.
const ref = yield * Content.upload(bytes) // { hash, size, grant }

// 2. In a turn: attach the reference under a name. This writes only this actor's shard.
Attach: Effect.fn(function* ({ name, ref }) {
  const turn = yield* Document.Turn
  yield* turn.blob(Attachments).attach(name, ref)
})

// 3. Off-turn: read the bytes through this actor's reference.
const bytes = yield * (yield * Document.Read).blob(Attachments).get("contract.pdf")
```

- `Actor.content(name)` declares a content blob and sits in the same `blobs` section as `Actor.blob`. Its entries are immutable references, not mutable bytes: `turn.blob(C)` offers `attach(name, ref)`, `detach(name)`, and `list()`; `read.blob(C)` offers `get(name)`, `stream(name)`, and `list()`, and stays read-only like every `BlobRead`.
- Mutable per-actor bytes stay `Actor.blob`. Shared immutable bytes are `Actor.content`. Each task still has one way.

### 2. Access: a reference is a grant, and a hash is not

- **Upload.** `Content.upload(bytes)` runs outside turns with the ambient tenant and caller. Served deployments get `POST /content`, authenticated like any route. The server computes SHA-256 over the bytes; clients never supply a hash. It returns `ContentRef { hash, size, grant }`.
- **The grant** is `g1.<key id>.<expires ms>.<mac>`. `mac` is HMAC-SHA-256, under a deployment secret, over `durable-content/v1`, the deployment, the tenant, the hash, the size, and the expiry. Grants last 1 hour.
- **Attach** checks the grant's MAC and expiry against the turn's database time, and checks that the tenant and hash match. It reads nothing, so the turn stays on the actor's shard. A bare hash, a grant for another tenant, or an expired grant makes `attach` fail with the typed error `InvalidContentRef`, which the command declares or handles like any other application failure; a reference from a client is input, not authority.
- **Copying between actors.** `Content.grant(Document, id, name)` hands out a fresh grant for an entry an actor already references. Like `Content.upload`, it is a framework content operation outside turns and queries, with the ambient tenant and caller; served deployments get `POST /actors/<Actor>/<id>/content/<blob>/<name>/grant`. It runs the actor type's `authorize` with the operation `<blob>.grant`, reads the reference on the actor's shard, and then raises `granted_until_ms` on the tenant's shard (§4). It writes no actor row and goes through no query, so queries and `BlobRead` stay read-only. Reaching content therefore always goes through an actor the caller is authorized to reach, as M4.md requires.
- **Reads** resolve the name to a hash through this actor's reference row, then read the bytes. A caller who knows a hash but holds no reference can't read anything.

### 3. Placement: references on the actor's shard, content on the tenant's

- **Content** is stored under the tenant's routing key (tenant placement's hash, whatever the referencing actor's placement), in `tenant_contents` (metadata) and `tenant_content_chunks` (1 MiB chunks). An upload writes it in its own transaction, which touches only the tenant's shard and is not a turn. If the hash already exists, the upload writes no bytes.
- **References** are rows in `actor_content_refs` on the actor's own shard. `attach` and `detach` write them in the turn, so they commit or roll back with the turn (T1) and never touch the tenant's shard.
- **Bytes are read only outside turns.** `read.blob(C).get` issues two single-shard statements: the reference on the actor's shard, then the chunks on the tenant's shard. A turn sees names, hashes, and sizes (`list()`), never bytes. On Neki that is what `tx_mode = 'single'` allows.
- **No reference counts.** Nothing increments or decrements a shared counter, so there's no hot row and no cross-shard message to keep in order.

### 4. Garbage collection: mark and sweep, gated by grants

- Every grant raises the content row's `granted_until_ms` to at least its own expiry before the grant is returned. That covers uploads, re-uploads of the same bytes, and `Content.grant`. It's a single-row write of framework metadata on the tenant's shard, made only by those two content operations. It never touches business data or actor rows, and no query or `BlobRead` makes it. The raise is one `UPDATE … RETURNING` on the tenant's row, and a grant is returned only if that statement found the row. `Content.grant` first resolves the name through the actor's reference, then runs the raise. If a detach and a sweep deleted the content in between, the raise finds no row, and `Content.grant` fails as it would for a name that doesn't exist, never with a grant for deleted content. If the raise runs first, it moves `granted_until_ms` past `sweep_start`, and the sweep's re-check keeps the content. The row lock orders the raise and the delete.
- A per-tenant sweep, under an advisory lock, runs at most once an hour:
  1. It takes `now` from the database as `sweep_start`, and computes the horizon `H = grace + T`. The grace defaults to 24 hours. `T` is the longest a turn transaction may stay open for any actor type that declares a content blob: its `commandTimeout`, which the runtime already enforces as the transaction's hard timeout, turn batches included. It picks candidates whose `granted_until_ms` is older than `sweep_start − H`.
  2. For a batch of candidates, it looks for any reference with that tenant and hash through the `(tenant_id, hash)` index on `actor_content_refs`. On Neki this is an explicit fleet-tier scatter on a dedicated connection. It is maintenance, never a turn path.
  3. It deletes candidates with no reference found, in a statement that re-checks `granted_until_ms < sweep_start − T`, and their chunks.
- **Why this is safe under concurrent attach and detach.** A reference the scan saw keeps its content. Take a reference committed after its shard was scanned, at time `c > sweep_start`. `attach` checked its grant at some time `t` in the same turn, so the grant's expiry was after `t`. The turn's transaction can't stay open longer than `T`, so `c < t + T`. The grant's expiry is at most the row's `granted_until_ms`, so `granted_until_ms > t > c − T > sweep_start − T`, and the re-check refuses the delete. A grant minted during the sweep raises `granted_until_ms` past `sweep_start` in the same way. Detaching can only make content collectable later, never earlier. The grace also covers clock skew between shards.
- **Retention of unreferenced content.** Content that no actor references is deleted once its last grant is more than `H` old. With the default 30-second `commandTimeout`, an upload that is never attached lives for about 25 hours (one hour of grant plus the grace). An actor type with a very long `commandTimeout` delays collection for its whole tenant by that much.

### 5. Isolation and limits

- Deduplication is per tenant only. The same bytes in two tenants are stored twice, so one tenant can never learn what another stores. Within a tenant, the upload response is the same whether or not the bytes already existed. Timing may differ; the uploader already holds the bytes, and the tenant is one trust domain.
- Every statement is scoped by `tenant_id`, and optional RLS covers the new tables like any other ([contract 10](../contracts/10-security.md)).
- One content is at most 64 MiB, written in 1 MiB chunks over several statements of the upload transaction. Content doesn't count toward an actor's `policy.maxBlobBytes`, because it isn't the actor's bytes. Per-tenant quotas are left to the application or the hosted plan (open question 4).
- Grant keys rotate like other deployment secrets. The key id in the grant lets the old key keep verifying for one grant lifetime after rotation.

## Alternatives rejected

- **Reference counts on the content row, updated through the outbox.** A popular hash becomes a hot row, and a delayed increment can arrive after a sweep has already deleted content at zero references, leaving a dangling reference.
- **The hash as the capability.** Anyone who can guess or learn a hash, for example of a public document, could read a tenant's copy. M4.md forbids it.
- **Content on the referencing actor's shard.** Deduplication across actor-placed actors would be impossible, since they sit on different shards.
- **Reading bytes inside a turn.** On Neki it needs a second shard in the turn transaction, which ADR 0006 forbids.
- **Object storage.** It gives no transaction with the turn and brings its own orphan handling, and vision 03 keeps blobs in the database. The cold tier (ADR 0036, proposed separately) is where object storage enters.
- **Cross-tenant deduplication.** It leaks whether another tenant stores given bytes.

## Consequences

- Attaching a shared file costs one row on the actor's shard, whatever the file's size.
- Serving bytes costs an extra single-shard statement, and handlers that need bytes run off-turn, in a query, a stream, or a connection handler, or clients fetch them through the served download route. Effect executors get no content access in this ADR, because `X.Executor` has no actor read context and executors may not require a database client ([contract 08](../contracts/08-background-work.md)). Giving executors a read path is open question 6.
- Collection is eventually consistent and bounded by the grace. Storage for unreferenced content lags by about a day.
- The sweep is the first framework maintenance job that scatters on Neki by design. It must be rate-limited and measured.

## Amendments on acceptance

**Contracts.**

- [06 storage](../contracts/06-storage-ownership.md): add content blobs beside actor blobs: tenant-placed content, actor-shard references written in turns, off-turn bytes, mark-and-sweep with grants, and per-tenant deduplication. Qualify "never share bytes", which stays true across tenants.
- [10 security](../contracts/10-security.md): a hash never grants access; grants are MAC'd, tenant-bound, and expiring; `Content.grant` is authorized by the actor type's `authorize` as `<blob>.grant`; deduplication never crosses tenants. Contract 06 gains the rule that the two content operations are framework writes on the tenant's shard, outside turns and queries.

**API.**

- [Server API](../api/01-server-api.md): `Actor.content(name)`, `Content.upload`, `Content.grant`, and `ContentRef`.
- [Context](../api/02-context.md): `turn.blob(C).attach/detach/list` and `read.blob(C).get/stream/list`.
- [Protocol](../contracts/protocol.md): `POST /content`, the grant route, and the served download route for a content entry.
- [Error model](../contracts/error-model.md): the typed `InvalidContentRef` failure of `attach`, which is an application failure, not an `ActorError` reason.

**Architecture and operations.** [Storage layout](../architecture/03-storage-layout.md) gets the new tables. [Retention](../operations/retention.md) gets the sweep and the grace. The [inspection views](../operations/inspection-views.md) get `durable.contents` and `durable.content_refs`. [Runbooks](../operations/runbooks.md) cover sweep lag and grant-key rotation.

**Verification.**

- [Conformance](../verification/01-conformance.md): a **Content blobs** gate row, and `conformance/content-blobs.ts` with the cases below.
- [Failure matrix](../verification/02-failure-matrix.md): "Crash after upload, before attach", "Sweep races an attach", and "Grant key rotated".
- [Performance](../verification/03-performance.md): the `content-blobs` benchmark.
- [Support matrix](../operations/support-matrix.md): a "Content blobs" row.

## Migration

Uses the reserved `0020_content_blobs`. It creates `tenant_contents`, `tenant_content_chunks`, and `actor_content_refs`, the latter with a composite foreign key to `actor_generations` and a `(tenant_id, hash)` index. There is no foreign key from references or chunks to `tenant_contents`, per ADR 0006.

## Open questions for Dallen, with recommended defaults

1. **What a grant is bound to.** Recommended default: the tenant, hash, size, and expiry, so a user can upload and then pass the reference to any command in the tenant. Alternative: also bind the caller, so a leaked grant is useless to anyone else, at the cost of blocking hand-offs between callers.
2. **Bytes inside turns.** Recommended default: never; turns see only names, hashes, and sizes. Alternative: allow reads in turns of tenant-placed actors, whose content shares their shard. That is a second rule to remember.
3. **Grant lifetime and grace.** Recommended defaults: 1 hour and 24 hours. Alternative: shorter values to reclaim storage sooner, with less margin for slow clients and clock skew.
4. **Size limit and quotas.** Recommended default: 64 MiB per content, with no framework quota. Alternative: a per-tenant byte quota enforced at upload.
5. **Spelling.** Recommended default: `Actor.content(name)`. Alternative: `Actor.blob(name, { shared: true })`, which puts two behaviours behind one constructor.
6. **Content in effect executors.** Recommended default: none in M4.13; executors that need bytes wait for a later ADR. Alternative: a read-only `X.Executor.content(ref)` that reads by grant from the tenant's shard, which amends contract 08's rule that executors hold no database capability.

## Evidence required

In `conformance/content-blobs.ts`, shared by PGlite and Postgres unless noted:

- `refuses to attach by bare hash, by another tenant's grant, or by an expired grant, and reads nothing without a reference` (hash-knowledge denial)
- `stores identical uploads once per tenant and twice across tenants` (dedup, and S2)
- `rolls back an attach and a detach with a declared failure or defect` (T1)
- `keeps content referenced by one actor after another detaches it`
- `collects unattached uploads after grant plus grace and never before`
- `never deletes content attached concurrently with a sweep` (Postgres, independent connections: the attach commits between the reference scan and the delete)
- `never deletes content whose attach checked its grant just before expiry and commits up to commandTimeout later` (Postgres, with the turn held open by a pause hook past the grant's expiry)
- `hands a fresh grant from one actor's reference to another actor's attach through Content.grant, and refuses a caller whose authorize denies <blob>.grant`
- `never returns a grant for content a concurrent detach and sweep deleted` (Postgres, independent connections: the sweep deletes between the reference read and the raise)
- `verifies grants under the previous key for one grant lifetime after rotation`
- `applies 0020_content_blobs to a database that ran the previous migration`

Benchmark `content-blobs`: deduplication ratio and bytes stored for a skewed upload set, upload and attach latency, read latency, and sweep cost per thousand candidates.

## Revisit when

- Content grows past what Postgres should hold, which points to the cold tier or an object-store backend.
- Tenants need deduplication across tenants, for example public assets.
- The sweep's scatter becomes expensive on Neki.
