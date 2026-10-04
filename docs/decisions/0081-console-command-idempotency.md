# Console command idempotency

Status: accepted.

## Context

The console generates UUIDs before sending commands so that a lost response can be retried. Runner admission accepts versioned, time-bound framework command ids, not arbitrary UUIDs. Passing a console UUID unchanged fails `InvalidCommandId`; treating that typed admission refusal as an API defect hid the actual failure.

## Decision

Keep the existing `SendCommand.commandId` field as the client idempotency key to preserve derived-client compatibility. `CommandSent.commandId` continues to report the assigned runner id. Persist an immutable assignment in `cloud_command_idempotency`, keyed by organization, project, environment, deployment-independent actor address, command and hashed client key, before delivering to the runner. Concurrent insertions return the same winning assignment. A canonical JSON payload hash binds its input; object key ordering does not change its meaning, while a changed payload returns `Conflict`.

Assignments store a SHA-256 hash of the client key, the canonical JSON payload hash, the runner-minted id and its expiry. Once that id expires, a bounded 1,000-row sweep clears the runner id and payload hash but keeps a tombstone for 30 days. Tombstones are then removed in bounded batches. A client key must remain unique for at least the retry window plus 30 days; reuse after that starts a new command. The tombstone race is serialized by the row lock and never remints an expired key.

Canonical JSON serialization sorts object keys recursively, preserves array order and JSON escape sequences, and normalizes numbers as their JSON encoding does. Full payloads are never retained. Existing JSON assignments migrate to hashes without changing their runner ids or input meaning.

Mint through the runner's `/command-ids` endpoint via the edge, never in the control plane's process clock. A crash before assignment may abandon an unused minted id but cannot deliver under it. A crash after assignment, including after the command commits but before its HTTP response, retries the assigned id. No retry replaces an expired assignment while its tombstone remains; reuse after the documented 30-day horizon is a new operation. Runner access and expiry checks still apply to every delivery, preserving the finite receipt horizon in [contract 04](../contracts/04-receipts.md). The runner id and scope are the result reference: keep outcomes in runner receipts rather than a control-plane cache. The runner sees the deployment's fixed control-plane caller; project writers are operators of that shared runtime surface, not distinct actor-level callers.

Send directly to actor addresses without an inspector preflight. First command delivery creates an actor; a missing inspector record must not prevent admission. Typed runner admission errors map to typed 4xx, and capacity/outage errors retain `Unavailable`. Remote defects and malformed responses remain opaque.

A full actor mailbox is capacity backpressure even though the runner serves it as HTTP 429: translate it to retryable `Unavailable`, not a terminal `CommandRefused`.

A runner `Defect` response is translated to an opaque, non-retryable 502 `RunnerDefect`; its trace details never cross the control-plane API.

Actor and receipt access denials remain `Forbidden`. A refusal of the control plane's deployment credential, or an unavailable reauthorization check, is a deployment outage and remains `Unavailable` on both minting and command delivery; it never asks the console user to authenticate again.

Rollback and redeploy messages identify the source's seven-character commit and message, rather than the deployment UUID. Local Compose passes its database-init shell script as one argument and exposes a configurable signing-key publication lead; the default remains five minutes.

## Evidence

`apps/api/src/runtime.test.ts` rejects forwarding a client UUID as a runner id, changed inputs, and missing replay metadata. `apps/api/src/repository.test.ts` checks concurrent assignment, immutable input, all scope fields, and restart persistence against Postgres. `apps/api/src/deployment-stack.test.ts` exercises first delivery, duplicate and conflicting client keys, deployment replacement and wake against real runners and edge. Local provider support additionally requires the full Compose rollout described in [cloud verification](../verification/cloud-deployments.md).
