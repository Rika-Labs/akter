# Durability, identity and outcomes

Status: proposal (0.2), owned by ADR 0124; promoted when E2 failure evidence lands.

**Responsibility:** define when an action is durable, what may be observed before that, how command identity deduplicates retries, and who may read a stored outcome.  
**Authority:** normative target on `rewrite/0.2`.  
**Owner role:** runtime architecture.  
**Change policy:** update the failure matrix, the [error model](error-model.md) and the [protocol](protocol.md) with every change.

## The durable prefix

- An action is durable when the log segment holding its entry exists in the store's bucket ([storage](06-storage.md)). Each shard's log is totally ordered by offset and gapless; its durable prefix is every segment up to the newest one written.
- Replies, events, state and list stream frames, view values, index contents, cross-shard deliveries and job starts MUST derive only from the durable prefix (I2). No reply MUST be sent and no event published before the segment holding the action's entry is durable.
- An action's staged sends, timers and job starts are part of its entry; they MUST become durable with the action or not at all.
- A runner MUST NOT acknowledge an action whose append outcome is unknown. An append that times out MUST be retried with the identical segment bytes; a create-once conflict on retry MUST be resolved by reading the existing segment's header: the owner's own `writer` and `open` mean success, anything else means the shard was lost. When retries are exhausted the owner MUST close the shard without publishing, and the next open MUST decide from the log whether the segment exists.

## Command identity

- An **external** command id is client-minted: `v1.<issuedAtMs>.<expiresAtMs>.<uuidv4>`. A client MUST send the same id on every attempt of one intent and MUST NOT mint a replacement for an id it has sent; a fresh id is a new operation.
- A **derived** command id is a UUIDv8 computed with `Crypto.digest("SHA-256")` from a parent id and an ordinal: sends and timers from the staging action's id, job calls from (job id, enclosing step name or `body`, attempt, ordinal within that scope), `ctx.id()` values from the action's id. Derived ids MUST be accepted only from the store's own log and from peer runners of the store; a derived id presented by a client MUST be refused with `InvalidCommandId` code `version`.
- The shard owner MUST refuse an external id, before any execution, with `InvalidCommandId` and a code: `malformed` (unparsable), `version` (not `v1`), `future` (`issuedAt` more than the store's future bound, default 60 seconds, after admission time; the refusal carries the owner's admission time and the client MAY resend the same id later), or `window` (`expiresAt` more than 10 minutes after `issuedAt`; the lifetime is fixed in 0.2.0 and not configurable). These are terminal and MUST NOT be retried with a new id automatically.
- An external id whose `expiresAt` is at or before admission time MUST be refused with `CommandExpired` carrying the id, whether or not any record of it remains. Admission time never decreases within a shard ([actions](02-actions.md)), so an expired id stays refused after deduplication state is dropped, after an owner change and after a restore.

## Admission order

For an external action the runtime MUST, in order: authenticate (transport), run `access` with kind `action`, validate the command id, check expiry against admission time, look the id up, and only then execute. A refusal at any step MUST write nothing and run no handler.

## Deduplication and stored outcomes

- For each admitted external id the shard MUST record: the id, the actor address, the member, the SHA-256 digest of the encoded payload, the logical caller (`User` subject, `Anonymous`, or `System` source, `ref` and `onBehalfOf`), the admission time and the encoded outcome (success value, declared failure or defect).
- A repeated id within its lifetime MUST NOT execute again (I4). The runtime MUST return the stored outcome only when the member and payload digest match and the logical caller is the original one; current access has already been checked for this request.
  - A different member or payload digest MUST fail with `InvalidCommandId` code `conflict` and MUST NOT reveal the stored outcome.
  - A different logical caller MUST fail with `Unauthorized` code `outcome_access_denied` and MUST NOT reveal or execute anything. Knowing a command id MUST NOT grant access to its outcome or permit a second execution under another caller.
  - Returning a stored outcome MUST NOT rerun the handler; the response MUST be marked replayed ([protocol](protocol.md)).
- Client ids MUST be deduplicated at shard level in time-bucketed pages keyed by expiry. A page MAY be dropped only when admission time has passed every `expiresAt` in it; its outcomes are dropped with it.
- Derived ids MUST be deduplicated by per-stream sequence watermarks: sends on the (sender shard, receiver shard) stream ([messaging](05-messaging.md)) and job calls on a per-job stream ([background work](08-background-work.md)). Each watermark MUST keep the outcome of every call not yet acknowledged by its caller. A per-job stream MUST retire when the job completes. Timer firings are deduplicated by the shard's own log.
- Deduplication state MUST be part of every checkpoint and MUST be rebuilt from checkpoint plus tail on open.
- An operator MAY read a stored outcome only with the `outcomes.read` capability ([security](10-security.md)).

## Revocation and accepted work

Revoking a caller's permission MUST block its new external admissions and its access to stored outcomes. It MUST NOT cancel or refuse already accepted durable work: staged sends, timers, job starts and job calls recorded by a durable action are trusted internal recovery and MUST proceed after the originating caller loses access or its external id expires. Cancellation is never implied.

## Caller deadlines

A caller that stops waiting (`Timeout`) learns nothing about whether the action became durable. It MUST retry with the same id to learn the outcome, and the runtime MUST NOT cancel an admitted action because its caller stopped waiting.

## Verification

I2, I3 (replay from any checkpoint yields the same states and outcomes), I4; F4 (duplicate id during and after its lifetime, including conflict and wrong-caller cases), F6 (crash after append before reply), F6′ (append succeeded, response lost), F10 (bucket unavailable or slow).
