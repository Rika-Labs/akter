# Console command idempotency

Status: accepted.

## Context

The console generates UUIDs before sending commands so that a lost response can be retried. Runner admission accepts versioned, time-bound framework command ids, not arbitrary UUIDs. Passing a console UUID unchanged fails `InvalidCommandId`; treating that typed admission refusal as an API defect hid the actual failure.

## Decision

Keep the existing `SendCommand.commandId` field as the client idempotency key to preserve derived-client compatibility. `CommandSent.commandId` continues to report the assigned runner id. Persist an immutable assignment in `cloud_command_idempotency`, keyed by organization, project, environment, deployment-independent actor address, command and client key, before delivering to the runner. Concurrent insertions return the same winning assignment. The original JSON payload is stored with it; object key ordering does not change its meaning, while a changed payload returns `Conflict`.

Mint through the runner's `/command-ids` endpoint via the edge, never in the control plane's process clock. A crash before assignment may abandon an unused minted id but cannot deliver under it. A crash after assignment, including after the command commits but before its HTTP response, retries the assigned id. No retry replaces an expired assignment: runner access and expiry checks still apply, preserving the finite receipt horizon in [contract 04](../contracts/04-receipts.md). Keep outcomes in runner receipts rather than a control-plane cache so current receipt-access authorization remains authoritative.

Send directly to actor addresses without an inspector preflight. First command delivery creates an actor; a missing inspector record must not prevent admission. Typed runner admission errors map to typed 4xx, and capacity/outage errors retain `Unavailable`. Remote defects and malformed responses remain opaque.

Rollback and redeploy messages identify the source's seven-character commit and message, rather than the deployment UUID. Local Compose passes its database-init shell script as one argument and exposes a configurable signing-key publication lead; the default remains five minutes.

## Evidence

`apps/api/src/runtime.test.ts` rejects forwarding a client UUID as a runner id, changed inputs, and missing replay metadata. `apps/api/src/repository.test.ts` checks concurrent assignment, immutable input, all scope fields, and restart persistence against Postgres. `apps/api/src/deployment-stack.test.ts` exercises first delivery, duplicate and conflicting client keys, deployment replacement and wake against real runners and edge. Local provider support additionally requires the full Compose rollout described in [cloud verification](../verification/cloud-deployments.md).
