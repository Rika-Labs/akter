# System topology

One environment has one store: a bucket or a scoped bucket prefix. Its descriptor fixes the store id, format, shard count, and initial retention; `meta/retention` holds the mutable effective policy. Every durable byte belongs to that store, including log segments, checkpoints, pages, index pages, leases, and audits.

An actor's address maps to a shard. Effect Cluster membership and `HashRing` assignment choose which runner tries to own each shard. Bucket-backed registrations, heartbeats, and locks are advisory. Only a create-once open segment establishes a new epoch and fences prior writers. There is no assignments object and no SQL authority.

A gateway routes commands and reads to the owner. Peers use Akter's mTLS transport; the forwarded caller is authenticated transport metadata, not an application payload. Owner loss ends live continuity and causes resubscription with a full durable frame. Authorized releases share a store-scoped peering identity; it adds no authority beyond the store bucket credential.

The public ingress is one RPC group at `/rpc`: JSON WebSocket sessions or NDJSON HTTP POST. Hosted orchestration, credentials, wake scheduling, and production provider validation belong to Akter Cloud. [E3 evidence](../verification/e3-cluster.md) covers local MinIO processes, not a production-provider fleet. The performance pass retunes advisory liveness to three seconds, membership refresh to 250 milliseconds and configured lock refresh to two seconds; orderly durable release also wakes peers immediately. The log fence remains authority, and local handoff timing is not a production-provider availability guarantee.
