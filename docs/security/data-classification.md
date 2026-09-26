# Data classification

**Responsibility:** control sensitive information across surfaces.  
**Authority:** security/operations.  
**Owner role:** security.
**Change policy:** a change requires security review.

Classify data at the field level across commands, receipts, keyed state, actor tables, events, workflow inputs and results, effect payloads, dead letters, blobs, connection state, logs, traces, and backups.

Bearer tokens, API keys, database URLs, provider credentials, signed URLs, and encryption material are secrets. Store configuration URLs as redacted values and never put credentials or raw auth headers in envelopes, receipts, logs, traces, client bundles, OpenAPI examples, or dashboards.

Principals, tenant ids, actor ids, command ids, connection ids, workflow keys, and trace ids are sensitive identifiers. They may be needed for attribution and incident response, but metrics must avoid high-cardinality identity labels and operator access must be audited.

Connection params, frames, and sessions are classified like command payloads, and the event cursors on delivered frames, open baselines, and `Resync` frames are visible metadata that reveals the actor's event rate unless the member sets `stampCursor: false`; sessions persist in `actor_connections` and must not hold credentials, and connection handler spans carry no frame, param, or session contents ([ADR 0023](../decisions/0023-connections-parking-and-streams.md)). Private command payloads can be persisted in messages or receipts; private effect payloads can remain in dead letters; events and blobs may be client-visible. Each contract therefore defines exposure and retention before deployment. Parked connection state is bounded session data, not a place for credentials.

Backups contain all tenants in a deployment database and inherit the highest classification present. Encrypt backups and blob stores, restrict restore access, and test redaction using representative failures rather than trusting logger configuration.
