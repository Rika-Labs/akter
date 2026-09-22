# Wire protocol

**Responsibility:** define transport-neutral frames.  
**Authority:** normative API contract.  
**Owner role:** protocol/SDK.
**Change policy:** a change requires an ADR and a conformance-suite update.

Each command request MUST carry actor identity, tenant routing derived at the trusted edge, a client-minted command id, caller attribution, trace context, and encoded input. HTTP MUST echo the command id as `x-request-id`. Retries MUST preserve the command id.

External receipt reads and replay MUST require current authorization for the original logical caller or explicit operator authority. External command delivery MUST reject expired identities even after pruning, under the [receipt contract](04-receipts.md). Trusted internal recovery of accepted work MUST remain distinct from new external admission. Any identity-bound expiry metadata MUST survive retries unchanged; transport adapters MUST NOT silently refresh it or mint a replacement id. The concrete encoding, clock rules, and error mappings require compatibility design before this protocol is implemented; see [versioning](../api/versioning.md).

The runtime MUST decode caller identity per request and serialize it into the envelope within the configured cluster-header limit. Missing credentials on an authenticated endpoint MUST return `ActorError(Unauthorized)` before a turn runs.

Commands MUST map committed outputs and declared failures through receipts. Framework failures MUST use the [single error envelope](error-model.md). Queries read committed rows without waking an activation. Event streams MUST carry cursors. Connections declared by `Actor.connection` MUST carry typed frames and restore parked connection state.

The Effect handle, Promise client from `durable-actors/client`, HTTP, WebSocket, and SSE adapters MUST preserve these semantics rather than define independent lifecycle states. Public spans MUST use `durable-actors.<Actor>/<Command>`.
