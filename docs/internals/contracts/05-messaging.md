# Messaging

Status: partially normative (0.2), owned by ADR 0126. [E3 cluster evidence](../verification/e3-cluster.md) covers durable send streams and owner routing for the currently served `default` tenant, including E5's derived job calls and receiver retirement. General tenant-address routing remains proposal; [E5 jobs](../verification/e5-jobs.md) owns the workflow guarantees.

**Responsibility:** define how actors message each other and how clients and jobs call actors.  
**Authority:** normative 0.2 target on `main`.  
**Owner role:** runtime.  
**Change policy:** wire changes require protocol versioning and replay tests.

## Calls from outside a command

- A call through `X.client(id)` from a client, a job or other server code MUST be a request/reply: the command runs on the owner and the reply is its recorded outcome after durability ([durability](03-durability.md)).
- The client MUST retry retryable failures with the same command id. There is no fire-and-forget call from outside a command.
- A job's calls MUST carry ids derived from the job id, the enclosing step name or `body`, the attempt and the ordinal within that scope ([background work](08-background-work.md)).

## Sends from a command

- `ctx.send(Target, id).<command>(payload)` stages a one-way command. It MUST become durable with the sending command and MUST be discarded with it ([commands](02-actions.md)).
- The delivered command MUST run as `System({ source: "send", ref: <sender address>, onBehalfOf })`, where `onBehalfOf` is the sending command's principal, and MUST carry a command id derived from the sending command's id and the send's ordinal.
- A send MUST stay in the sender's tenant: `Target` and `id` name an actor in the same tenant; no send API accepts a tenant.
- **Same shard.** A send to an actor on the sender's shard MAY execute immediately after the sender, speculatively; its entry MUST follow the sender's in the same shard log.
- **Another shard.** A send to another shard MUST NOT be delivered before the sender's segment is durable. It then waits in the sender shard's pending sends (part of every checkpoint) and is delivered to the receiver's owner.
- **Exactly once.** Each (sender shard, receiver shard) pair is a stream with a monotonic sequence. The receiver MUST apply each sequence number at most once and in order, recording an `Action` with `Delivery` origin (the received record) and the stream's watermark in its shard state; the watermark never expires. The sender MUST record `Delivered` only after the receiver's segment holding the delivery is durable, and MUST retry delivery under the same sequence and derived id until then (I5).
- Delivery of a durable send is trusted internal recovery. It MUST NOT be refused because the originating caller lost access or its external id expired, and it MUST survive owner changes and release handoffs on both sides: pending sends move with the sender shard's checkpoint and the receiver's watermark moves with the receiver's.
- Ordering is guaranteed only within one stream. Sends from different shards to one actor have no relative order.

## No distributed transaction

Messaging MUST NOT be presented as a synchronous remote call from a command. A send's effect on the receiver is a separate command, durable on the receiver's shard, never atomic with the sender's.

## Timers

`ctx.schedule(durationOrDate).<command>(payload)` stages a timer on the acting actor; its firing is specified in [background work](08-background-work.md).

## Verification

I5 (a cross-shard send is applied exactly once); F3 (same-shard send whose sender segment is lost), F13 (cross-shard send lost, duplicated, or delivered after the sender's shard moves), F16 (partition between gateway and owner).

[E3 cluster evidence](../verification/e3-cluster.md) maps split-shard seeds, same-id routed replies, forwarded caller authorization, held/lost peer replies and real runner processes to those failures. A peer request is bounded; a timeout does not revoke a durable command, and its client retries the same id. A draining gateway refuses instead of forwarding new calls.
