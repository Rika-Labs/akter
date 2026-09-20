# ADR 018: Actor namespaces over shared object storage

Date: 2026-09-17  
Status: Accepted capability; provider conditional

## Context
Large artifacts belong outside relational rows, but a bucket/server per actor is needless infrastructure.

## Decision
Use an actor-scoped BlobStore over shared S3-compatible storage; R2 pilot or S3 by deployment economics. Immutable objects and committed references handle cross-store consistency.

## Alternatives considered
Storing all blobs in SQLite creates write/storage pressure. Treating S3 writes as part of a SQL transaction is rejected.

## Consequences and risks
Orphans, cleanup, signed URLs, permissions and cross-provider egress require explicit design.

## Validation and revisit trigger
Provider selection follows conformance and region/compliance/cost tests, not an abstract egress slogan.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [S3 consistency](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Tigris docs](https://www.tigrisdata.com/docs/)
