# 06 — Blob storage

**Status:** actor-scoped blob storage is accepted product scope. The API, immutable-key discipline, cleanup protocol, and S3-compatible/filesystem/memory adapters below are **proposed and unverified**.

See the [v3 index](../../README.md), [decisions](../../DECISIONS.md), and related [background work](../07-background-work/README.md) and [operations](../15-operations/README.md) specifications.

## Product contract

Blob storage keeps large bytes near actor-owned truth without pretending an object store is transactional.

- Outside a command turn, `ctx.blobs` automatically scopes every key to the current actor; callers do not construct or authorize an actor prefix.
- Blob bytes are uploaded, downloaded, streamed, inspected, and deleted **outside** turns.
- A command stores a validated `BlobRef` in ordinary business rows through directly yieldable `ctx.database`.
- A turn may create durable activity/job/workflow intents, but cannot perform object-store I/O.
- Blob operations and a database commit are never one atomic operation. Reconciliation is part of the contract.
- Immutability (new bytes require a new key) is the proposed default, not yet an accepted API detail.

One context name does not grant every phase the same powers: an HTTP/upload handler or worker can stream bytes; a command context can validate a staged reference and write business state, but has no byte-writing capability.

```diagram
browser ── signed PUT ──▶ staged actor prefix ── verify ──▶ command turn
   │                           │                              │
   │                           │ bytes (nontransactional)     │ BlobRef row
   │                           ▼                              ▼
   └──────────────────── object adapter                 ctx.database
                               │                              │
                               └──── reconciliation ◀─────────┘
                                      orphan / missing
```

## Proposed API sketch

All names and types in this section are **proposed, incomplete, and not compiler-verified**.

```ts
// Proposed outside-turn capability; actor scope comes from Context.
const ctx = yield* Context

const ref = yield* ctx.blobs.put(
  "attachments/01K.../original.pdf",
  request.body,
  { contentType: "application/pdf", checksum: request.checksum },
)

const body = yield* ctx.blobs.get(ref.key) // Effect<Stream<Uint8Array>, ...>
const info = yield* ctx.blobs.head(ref.key)
const entries = ctx.blobs.list("attachments/") // Stream<BlobInfo>
const download = yield* ctx.blobs.presign(ref.key, {
  method: "GET", expiresIn: "5 minutes",
})
yield* ctx.blobs.delete(ref.key)
```

The public key is actor-relative. A proposed adapter maps it to a physical, tenant-separated key similar to:

```text
projects/<project-id>/tenants/<tenant-id>/actors/<type>/<encoded-id>/<key>
```

The runtime must derive every prefix from authenticated routing identity, use unambiguous encoding, and reject `..`, absolute paths, alternate separators, and normalization collisions. Listing and deletion cannot escape that prefix. Bucket credentials are not application-visible.

## Direct upload and verification

Browser upload is a staged protocol, not “presign then trust the key.”

```ts
// Proposed HTTP handler, outside a turn.
const ctx = yield* Context
const upload = yield* ctx.blobs.createUpload({
  key: `attachments/${crypto.randomUUID()}/original.pdf`,
  contentType: "application/pdf",
  maxBytes: 20_000_000,
  checksum: clientSha256,
  expiresIn: "10 minutes",
})
return { uploadId: upload.id, url: upload.url, headers: upload.headers }
```

```ts
// Proposed outside-turn finalization after the browser PUT.
const ctx = yield* Context
const verified = yield* ctx.blobs.verifyUpload(uploadId, {
  expectedChecksum: clientSha256,
  expectedContentType: "application/pdf",
  maxBytes: 20_000_000,
})
yield* order.commands.attachUpload({ attachmentId, blob: verified }, {
  commandId: `attach:${uploadId}`,
})

// Proposed command: stores only the admission-verified reference; no blob I/O.
const attachUpload = {
  input: AttachmentInput,
  handler: ({ attachmentId, blob }) => Effect.gen(function* () {
    const ctx = yield* Context
    yield* ctx.database.insert(attachments).values({
      attachmentId,
      blobKey: blob.key,
      sha256: blob.checksum,
      byteLength: blob.byteLength,
    })
  }),
}
```

`verifyUpload` is proposed to create a runtime-signed, actor-bound durable attestation after adapter verification. Command admission validates that attestation locally before starting the turn; it must not perform an object-store `HEAD` while holding the turn. The final design must prove attestations cannot be forged, replayed for another actor, or changed between verification and reference commit. An alternative is an activity that verifies and sends the completion command.

Signed URLs must be short-lived, method-bound, key-bound, tenant-bound, and constrained by size/content type/checksum where the provider supports those conditions. A successful PUT response alone does not prove the expected bytes exist. Download signing requires authorization before URL issuance; URLs are bearer credentials and must not appear in logs.

## Immutability and lifecycle proposal

An immutable key names one byte sequence. Conditional create (`If-None-Match: *` or provider equivalent) should reject replacement. Where an adapter cannot enforce conditional creation, the support matrix must say so; content-addressed suffixes and post-write checks do not by themselves remove races.

Reference changes use three phases:

1. Write bytes under a fresh staged key outside the turn.
2. Verify metadata and commit the `BlobRef` in a command.
3. Mark the upload claimed after commit; cleanup eventually removes unclaimed staged bytes.

Deletion reverses the asymmetry: first remove or replace the business reference in a command, then enqueue deletion. Deletion is idempotent. A failed delete leaves garbage, not a dangling authoritative reference.

A reconciler should compare runtime upload records, business references, and adapter inventory by bounded prefix/page. It must quarantine before destructive cleanup, respect a grace period longer than maximum upload/command delay, retry safely, expose age/backlog, and never infer tenancy from caller-supplied text. Missing referenced objects produce a visible integrity finding; cleanup must not erase the reference to hide it.

## Adapter direction (unverified)

| Adapter | Intended use | Required evidence before support |
| --- | --- | --- |
| S3-compatible | AWS S3, R2, MinIO, Tigris-like services | Per-provider signing, conditional writes, checksum semantics, pagination, consistency, multipart aborts |
| Filesystem | Local development | Atomic create behavior, traversal/symlink defense, crash-safe metadata, same scoping errors |
| Memory | Deterministic unit tests | Bounded memory, fault injection, streaming/backpressure, production use explicitly rejected |

“S3-compatible” is not one behavioral guarantee. Publish a pinned provider matrix. Multipart uploads need expiry and abort cleanup; encryption, retention locks, versioning, and malware scanning are deployment policies rather than assumed universal behavior.

## Failures, limits, and security

- A crash after upload but before reference commit creates an orphan; a crash after reference removal but before delete creates garbage. Both are expected and reconcilable.
- A database restore can resurrect references to deleted bytes or forget references to existing bytes. Restore procedures must pause destructive cleanup and reconcile before resuming it.
- Blob storage is not business truth, a database provider, or a transaction participant. Listing is operational discovery, not an authoritative index.
- Streaming must apply byte, duration, concurrency, and egress limits with backpressure. Do not buffer arbitrary objects in actor memory.
- Metadata and filenames are untrusted. Prevent header injection, content-sniffing surprises, decompression bombs, malicious documents, and public-cache leakage.
- Server-side encryption does not replace tenant authorization. Secrets and provider credentials remain worker-only and require rotation.
- Worker jobs may create bytes, but completion commands perform business writes; workers receive read-only shared SQL access and the minimum blob prefix authority.
- Purging an actor must account for legal holds, retained versions, in-flight uploads, and references shared by design. Cross-actor shared blobs are unsupported until ownership and deletion semantics exist.

## Open questions

1. Is immutable create mandatory for every production adapter, and what is the exact conditional-write fallback?
2. Is `verifyUpload` backed by a gateway receipt, an activity completion, or both?
3. Which checksum algorithms and multipart checksum semantics are portable enough for the public contract?
4. What grace, quarantine, retention, and legal-hold defaults apply before orphan deletion?
5. Are deduplicated/content-addressed blobs ever shareable across actors without weakening scoped deletion?
6. How are blob references discovered safely across user-defined Drizzle schemas during purge and reconciliation?

## Falsifiable validation gates

No runtime test is claimed here. Support requires all of these experiments:

- Attempt traversal, Unicode normalization collisions, encoded separators, foreign actor keys, and cross-tenant signed URLs against every adapter; every access is rejected without revealing existence.
- Race two distinct writes to one immutable key; exactly one byte sequence remains, or that adapter is excluded from immutable support.
- Kill the process after byte upload, after attestation, before reference commit, and after reference removal; reconciliation converges without deleting a live reference.
- Tamper with upload ID, key, size, MIME type, checksum, expiry, actor, and tenant; the command cannot commit a reference.
- Stream an object larger than configured limits through slow clients while saturating concurrency; memory stays bounded and unrelated actors progress.
- Restore a database backup behind object storage, pause cleanup, and demonstrate a report of both missing references and orphan objects before any deletion resumes.
- Run the same contract suite against pinned S3-compatible providers, filesystem, and memory; publish differences rather than normalizing failures away.
