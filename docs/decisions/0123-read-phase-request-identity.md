# ADR 0123: Read-phase request identity

Status: accepted, 2026-10-12.

**0.2 status:** amended (request identity carries onto views and sessions); owned by [ADR 0130](0130-views-sessions-events-and-rpc.md). See the [0.2 registry](0124-engine-rewrite-and-command-log.md#registry-of-earlier-decisions).

## Context

Query and stream handlers receive a correctly scoped `X.Read`, but they may also use public `CurrentCaller` and `Tenant` references in application services. A query omitted request bindings, and a stream's bindings were outside a provided handler context that could overwrite them with layer-builder identities. Real public HTTP over local Postgres reproduced an authenticated tenant `a` query observing ambient tenant `default` and caller `Anonymous` while `X.Read` correctly named `a` and `alice`.

## Decision

Bind the admitted query or subscriber's caller and tenant into the handler context after selecting its application services, so request identities override layer-builder identities. Ordinary queries and streams retain their existing application services. Watch reruns still receive no unrelated application service; the two public identity references match their `X.Read` identity.

This restores the trusted-ingress rule of ADR 0059 and contract 10. It does not alter admission, authorization, receipts, actor ownership, query snapshots or the ban on mutation/request-reply from read phases. No connection, workflow or job context is changed.

## Evidence and consequences

The [focused regression](../../packages/akter/src/actor/reads.test.ts) uses asymmetric request identities and a deliberately different layer-builder identity in ordinary-query, watch and stream paths. Each path independently rejects the old context behavior. [Verification](../verification/read-request-context.md) records the public HTTP reproduction and the limits of the evidence; no production cross-tenant data exposure was demonstrated.

Applications that incorrectly depended on a read handler running as its layer-builder must instead name that trusted identity explicitly outside the handler. Correctly scoped actor capabilities remain unchanged. The fix adds no database statement or network flight.
