# Actor-scoped blob storage

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

Choose an S3-compatible capability with actor-scoped keys, not one bucket per actor. Hosted pilot default: R2 subject to region/network/compliance tests; ordinary AWS S3 is the conservative alternative when same-region compute or compliance makes it preferable. Self-hosters bring an S3 endpoint; local development uses a filesystem adapter. SeaweedFS is an evaluation candidate, not an asserted drop-in with every production feature.

## Namespace and permissions

Physical paths include application, environment, actor type, stable actor ID, incarnation and object ID. Encode path components unambiguously; prevent traversal and prefix confusion. Prefix naming is organization, not authorization. Credentials/presigned URLs must restrict bucket/key/method/expiry and be issued by the trusted runtime.

## Commit behavior

Object storage and SQLite do not share a transaction. Prefer immutable content-addressed/versioned objects. Upload first through an activity, then commit the object reference into actor state. A crash after upload but before reference leaves an orphan; garbage-collect it after a safe grace window. A crash after reference commit must not result in the object being deleted as an orphan. Replacements create a new version before switching the reference.

Avoid exposing `BlobStore.put` as if it participates in a local actor transaction. Its result and cleanup state are tracked external work. Blob read failures surface typed unavailable/not-found/checksum errors. Sensitive content can require envelope encryption and managed keys; encryption at rest alone does not prevent an over-broad actor grant.

## Portability contract

Test PUT/GET/HEAD/DELETE, range requests, multipart upload/abort, checksums, URL signatures, conditional operations, metadata limits, Unicode keys and endpoint TLS behavior. Do not require provider-only features in the core interface. Define atomic visibility assumptions precisely; do not infer cross-key transactions.

## Economics

Track bytes retained, requests, outbound transfer from compute to object storage, retrieval and orphan retention. 'No egress fee from R2' does not mean Railway-to-R2 traffic or downstream delivery is free. Object metadata per actor and listing/cleanup operations can dominate tiny objects. Bundle small artifacts or store small records in SQL when appropriate.

## Sources and evidence

- [A01: S3 consistency](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html) — Object-store consistency does not create atomicity with actor database commits.
- [A02: Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/) — S3-compatible storage alternative, request/storage billing; ecosystem egress still exists.
- [A03: Tigris docs](https://www.tigrisdata.com/docs/) — Object storage candidate, regional placement and S3 API compatibility must be tested.
- [A14: SeaweedFS S3-compatible storage](https://github.com/seaweedfs/seaweedfs) — Self-host candidate to evaluate against S3 conformance tests; not interchangeable merely because an S3 endpoint exists.
- [D04: Railway resource pricing](https://railway.com/pricing) — Meter and plan source; model unverified rates as assumptions.
