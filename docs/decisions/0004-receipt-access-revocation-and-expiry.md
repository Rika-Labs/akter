# ADR 0004: Receipt access, revocation, and command expiry

**Status:** accepted design (2026-09-22); command expiry and whole-database restore are implemented and covered by `conformance/restore.ts`; conformance for the remaining checks below stays with their owning slices.

**Responsibility:** record the owner's remaining retry and authorization choices before decomposing the framework backlog.

**Authority:** historical decision record.

**Owner role:** runtime architecture.

**Change policy:** supersede through a new ADR when these semantics change.

## Context

The receipt contract previously required replay without specifying who could read the stored outcome. It also tied deduplication to retention without defining what happens after cleanup. Persisted caller attribution and the signed-assertion decision in [ADR 0003](0003-failure-scoping-drain-and-hosted-trust.md) did not settle permission revocation after durable admission.

The owner selected original-caller receipt access with current authorization, continued execution of already accepted work after revocation, and rejection of expired command identities. This ADR qualifies unconditional receipt-replay wording and resolves these choices without implementing a runtime.

## Decisions

### Receipt access belongs to the original logical caller

A stored output or declared failure is accessible only to its original logical caller with current resource/operation authorization, or to an operator explicitly authorized for that receipt. Credential rotation does not change logical caller identity. Possessing a command id or having access to the same tenant or actor is insufficient.

Deduplication remains keyed by tenant, actor identity, and command id, with command name and payload binding. Caller identity is an access condition, not another deduplication partition. A different caller reusing the same id must neither obtain the outcome nor execute the operation again. Concurrent duplicates must resolve against the same durable identity.

Replay does not run the handler, so receipt access must be checked separately from handler authorization. The durable logical-caller representation and replay-authorization interface remain implementation design work, including System/on-behalf-of attribution and intentionally anonymous callers. An undifferentiated `Anonymous` identity cannot promise isolation between individual anonymous clients.

### Revocation blocks new access, not accepted work

Revoking a principal's access blocks new external admissions and receipt reads. Already accepted durable work continues with its recorded System/on-behalf-of attribution, including internal redelivery and workflow recovery. Canceling accepted work is an explicit operation, not an implicit consequence of credential expiry or permission revocation.

Applications may explicitly reauthorize sensitive steps. Cancellation cannot undo completed provider calls; ambiguous external outcomes still require reconciliation or proven provider idempotency. An external request cannot claim to be internal recovery to bypass revocation.

Live connections and subscriptions must reauthorize or disconnect within a documented revocation bound, including after parking and resumption. No indefinite session authorization is implied. Concrete authorization-freshness rules and the revocation bound must be specified and tested before transport support is claimed.

### Expired command identities cannot become new operations

External command retry and receipt-retention horizons are finite and configurable. An external delivery with an expired command identity is rejected, rather than executing again after its receipt has been pruned. Rejection also applies to a first delivery that arrives after its identity expires. Expiry is not evidence that a previous attempt failed or that no effect occurred.

Receipt deletion alone cannot enforce this rule: an absent receipt cannot distinguish a new command from an old retry. Before cleanup is enabled, the identity/admission protocol must enforce expiry even after pruning, restart, and supported restore. It must bind any expiry metadata to the command identity, prevent refreshing an old identity into a new operation, and define clock, boundary, and rolling-version behavior. No particular timestamp format, admission token, tombstone scheme, or numeric default is selected here.

External retry expiry does not cancel accepted work or expire trusted internal redelivery. Cleanup must preserve deduplication evidence for pending messages, workflows, intents, and effects until their recovery obligations end. Receipt/result retention and internal recovery lifetimes therefore need not be identical. Cleanup and admission must not race into a second execution.

Clients preserve the original identity and any required expiry metadata across retries. Neither the Effect handle nor the Promise client may silently mint a replacement id after expiry. A fresh identity represents an explicit new business operation, not a safe retry of an unknown outcome.

## Alternatives

- Let any currently authorized actor caller read a receipt: rejected; actor access does not grant access to another caller's stored result.
- Partition receipt deduplication by caller: rejected because a second caller could execute the same command identity again.
- Automatically cancel accepted work when the originating principal loses access: rejected in favor of explicit cancellation and optional application reauthorization.
- Retain every receipt forever: rejected as the default retention model.
- Treat an expired/pruned id as new: rejected because it can silently repeat business consequences.

## Consequences and evidence

The receipt, security, retention, dispatch, protocol, SDK, and verification documents must express the same boundaries. The existing `ActorError` reason set and credential-only `Unauthorized.code` values do not yet specify receipt-access denial and command-expiry mappings. Those wire mappings, narrowed error channels, and migration rules require explicit API/version compatibility design before implementation; this ADR does not invent an implemented error API.

Required checks cover rotated credentials, different callers with equal ids, scoped operator access, revocation before and after admission, internal recovery, parked/live sessions, expiry boundaries, cleanup races, restart/restore, and client retry behavior. They are listed in conformance. None has been executed by this documentation change.

## Revisit when

- A concrete public/anonymous workload needs a different receipt-access policy.
- A workload requires automatic revocation-driven cancellation instead of explicit application policy.
- The selected identity protocol cannot enforce finite external retries without losing accepted work or allowing duplicate execution.
