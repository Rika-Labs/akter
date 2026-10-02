# ADR 0050: Operator authority, audited repair, and `durable inspect`

**Status:** accepted (2026-09-30, Dallen). Built with M4.6 ([#226](https://github.com/Rika-Labs/akter/issues/226)). It makes concrete the operator rule of [ADR 0003](0003-failure-scoping-drain-and-hosted-trust.md) and the operator receipt access of [ADR 0004](0004-receipt-access-revocation-and-expiry.md), amends [ADR 0049](0049-observability-names-metrics-and-defect-spans.md) section 3, and uses migration `0023_operator_audit`.

**Responsibility:** define who is an operator, what an operator may do to which resources, how each operator action is recorded, and what `durable inspect` shows.

**Authority:** decision record.

**Owner role:** security/runtime.

**Change policy:** supersede through a new ADR.

## Context

ADR 0003 requires "separate action- and resource-scoped capabilities and audited repair intents" for operator actions, and says application credentials or a claimed System caller never grant them. [Contract 04](../contracts/04-receipts.md) and [contract 10](../contracts/10-security.md) allow a stored outcome to be read by "an operator explicitly authorized for that receipt". The [authorization model](../security/authorization-model.md) lists administration, drain, dead-letter repair, and reconciliation as operator work, and requires repair records to name the operator, target, and reason. Nothing implements any of it: the inspector (CR.5) and `durable defects list` (M4.3) authenticate an application principal and trust its tenant, and dead letters can only be read.

[M4](../milestones/M4.md) asks for operator capabilities scoped by action and resource, audited repair intents, and `durable inspect Room/r1`, with the operator halves of **Hosted assertions and operator authority** and **Receipt access without re-execution** and the failure row "Application credential attempts operator repair".

## Decision

### 1. Operators are a separate principal with explicit grants

- **An operator is not a `Caller`.** `Actor.auth` providers return `{ tenant, caller }` for application requests; operator routes accept only an `OperatorAuth` provider, which returns an `OperatorGrant`: `{ operator: string, capabilities: ReadonlyArray<Capability> }`. No `Caller`, including `System`, converts to a grant, and no operator route accepts an `Actor.auth` provider, so an application credential cannot reach an operator action by type or at runtime.
- **A capability is one action on one resource scope:** `{ action, tenant, actorType?, actorId?, commandId? }`. `tenant` is a tenant id or `"*"` for every tenant of the deployment; each omitted field matches any value. `commandId` narrows `receipts.read` to one receipt.
- **Actions:**

  | Action                 | Allows                                                                                                       |
  | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
  | `inspect`              | an actor's generation, state, events, outbox, effects, dead letters, workflows, and receipt metadata         |
  | `receipts.read`        | stored outcomes (success values and declared failures); without it, inspection shows each receipt's tag only |
  | `defects.read`         | the runner's defect spans ([ADR 0049](0049-observability-names-metrics-and-defect-spans.md) section 3)       |
  | `dead-letters.retry`   | performing a dead-lettered effect again, as a new effect                                                     |
  | `dead-letters.discard` | deleting a dead letter                                                                                       |
  | `subscriptions.skip`   | skipping a stuck subscription row's events through a cursor, scoped to the source actor                      |
  | `audit.read`           | reading the operator audit log                                                                               |

- **Providers.** `OperatorAuth.make(authenticate)` wraps a function from the request to a grant or `Unauthorized`, for an identity provider or signed operator assertions. `OperatorAuth.tokens([{ token, grant }])` checks a bearer token against configured `Redacted` tokens by SHA-256 digest, comparing every configured digest in full, for a small deployment and the CLI.

### 2. Every authorized operator action is audited

- **Migration `0023_operator_audit`** adds `actor_operator_audit (routing_key, audit_id, at_ms, operator, action, tenant_id, actor_type, actor_id, target, capability, reason, outcome)`, primary key `(routing_key, audit_id)`, an index on `(tenant_id, at_ms)`, the read-only view `durable.operator_audit` (version 1, joined to `actor_placements` like the other views so it can't be written through), and its row in `durable.views`. `routing_key` is the target actor's, or the tenant's routing key for a tenant-wide action, so a repair and its record are one single-shard transaction. `capability` is the JSON of the capability that authorized the action; `outcome` is JSON (`{ "effectId": … }` for a retry, `"denied"` for a refusal).
- **A repair and its audit row commit in one transaction.** If either fails, neither happens.
- **A read is audited before it is answered.** `inspect`, `receipts.read`, `defects.read`, and `audit.read` write their row first; a request whose row cannot be written is refused.
- **An authenticated operator refused by scope is audited** with outcome `"denied"`. A request that fails authentication is not audited, because an unauthenticated caller could fill the table; it is logged as a warning with no credential. A repair that is authorized but refused by its own rule (`NotFound`, `ProviderOutcomeUnknown`, `EffectNotServed`) rolls back with nothing written.
- **Repairs require a reason**, 1–500 characters, stored as given.
- **Audit rows are never pruned by the runtime.** No runtime retention sweep touches `actor_operator_audit`; their retention is the operator's, like dead letters'.

### 3. Dead-letter repair respects provider outcome safety

- **Retry performs the effect again as a new effect.** It needs a runner that registers the actor's effect layer, which says whether the effect is capped; another runner answers `EffectNotServed` (503). In one transaction under the performing actor's routing key, it locks the dead letter, stages a new effect row with the stored effect name and payload through the turn's own outbox statements (so a capped effect queues behind its type's earlier rows), deletes the dead letter, and writes the audit row with the new effect id. The new effect has a new effect id, so its routes cannot collide with the receipt of the original's `onDeadLetter` delivery, which used the original id. Its caller is `System({ source: "actor", ref: <actor> })` with no `onBehalfOf`: the retry is the operator's act, and the audit row names the operator.
- **An ambiguous dead letter is not retried by default.** When `ambiguous` is true the provider may have applied the call, and the new effect id is a new idempotency key. Retry refuses it with `ProviderOutcomeUnknown` unless the request sets `providerChecked: true`, the operator's statement that they reconciled with the provider; that flag is stored in the audit row. Permission to retry is never proof that repeating the call is safe.
- **Discard deletes the dead letter** and records its effect, attempts, `ambiguous`, and cause in the audit row, never its payload.
- **A dead letter is repaired at most once.** Both actions delete the row they lock, so a second request finds nothing and fails `NotFound`.

### 3a. A stuck subscription row is skipped by an operator, never automatically

[ADR 0026](0026-cross-actor-event-subscriptions.md) question 6 leaves a poison delivery blocking its row, retried with capped backoff, until a person decides to skip it. `POST /operator/subscriptions/skip` with `{ tenant, sourceType, sourceId, subscriberType, subscription, subscriberId, through, reason }` needs `subscriptions.skip` covering the tenant and the _source_ actor.

- **Only a failing row is skipped.** The row must be active, hold a `last_error`, and have `delivered` below `through`, which must be at most the source's head cursor. Otherwise the request fails `NotFound` and changes nothing.
- **The skip and its audit row commit in one transaction,** on the source's shard, and the audit outcome records the cursor delivered before, `through`, and the `last_error` it cleared.
- **The row moves on with a marker.** It resets `attempts` and `last_error`, becomes due at once, and records the skipped range as a gap; the relay's existing gap delivery sends the subscriber a `RetentionGap` for `(delivered, through]` before the events after `through`. An id-routed subscription has no recipient for a marker and counts the gap on the row, as it does for pruning. A delivery that held the claim loses its fence and settles nothing.
- **CLI.** `durable subscriptions skip --source Order/o1 --subscriber Follower/f1 --subscription FollowedOrders --through 42 --url <runner> --tenant <t> --reason "…"`. `durable subscriptions list --lagging --url <runner> --tenant <t> [--min-attempts 8] [--limit n]` lists the tenant's active rows that have failed at least `--min-attempts` deliveries in a row (default 8), most attempts first, each with its source, subscriber, `delivered` and head cursors, lag, attempts, and `last_error` (question 6 of ADR 0026). It calls `GET /operator/subscriptions/lagging?tenant&minAttempts&limit`, which needs a tenant-wide `inspect` capability (an actor-scoped grant does not cover it) and audits the read before answering. `--lagging` is required because it is the only listing.

### 4. Receipts are read without re-execution

`GET /operator/receipts/:type/:id/:commandId?tenant=` reads the stored receipt in a read-only transaction and returns its command, outcome tag, decoded value or declared error, and expiry. It never admits a command, never runs a handler, and never writes a receipt. It needs `receipts.read` covering the tenant, actor, and command id.

### 5. `durable inspect` and the operator routes

- **`Operators.serve({ auth, basePath? })`** adds routes to the application's `HttpRouter` (default prefix `/operator`): `GET /actors/:type/:id?tenant&limit`, `GET /receipts/:type/:id/:commandId?tenant`, `GET /defects?tenant&actor&sinceMs&limit`, `POST /dead-letters/:effectId/retry` and `/discard` with `{ tenant, actorType, actorId, reason, providerChecked? }`, `POST /subscriptions/skip`, `GET /subscriptions/lagging?tenant&minAttempts&limit`, and `GET /audit?tenant&limit`. `tenant` may be `*` for `defects` and `audit`, which then needs a capability for every tenant. A browser request from another origin is refused before authentication, as the inspector's are. Failures answer 401 (not authenticated), 403 (`Unauthorized` `access_denied`), 404, 409 (`ProviderOutcomeUnknown`), or 503 (`EffectNotServed`). Serve them on an operator listener.
- **`Telemetry.serve({ basePath? })` keeps only `GET /metrics`;** `GET /defects` moves to `Operators.serve` under `defects.read`, amending ADR 0049 section 3.
- **CLI.** `durable inspect Room/r1 --url <runner> --tenant <t> [--receipts 5] [--json]`; `durable receipts show Room/r1 <commandId> …`; `durable dead-letters retry <effectId> --actor Room/r1 --reason "…" [--provider-checked] …`; `durable dead-letters discard <effectId> --actor Room/r1 --reason "…" …`; `durable subscriptions skip …`; `durable subscriptions list --lagging …`; and `durable defects list` now uses the operator token. Each reads the bearer token from `DURABLE_OPERATOR_TOKEN` (`--token-env` overrides).

## Alternatives rejected

- **An `Operator` variant of `Caller`.** Every authorize hook and handler would have to reject it, and a hook that forgot would let an application path act as an operator.
- **Operator authority from database credentials only** (operators run SQL). SQL bypasses the capability scope and writes no audit row; the read-only `durable` views stay available for dashboards.
- **Retrying under the original effect id.** It would keep the provider's idempotency key, but the original id already names the `onDeadLetter` route's receipt on the performing actor, so the retried effect's routes would replay that receipt instead of running.
- **Auditing through application logs.** Logs are not transactional with the repair, and a repair whose record was lost would be indistinguishable from none.

## Consequences

- `@rikalabs/akter/runtime` exports `Operators.serve`, `OperatorAuth.make` and `.tokens`, and the `OperatorGrant`, `Capability`, `OperatorAction`, and `AuditRecord` schemas.
- `akter.effect.dead_letters` is unchanged; retried and discarded dead letters are visible in `durable.operator_audit`.
- The inspector's "Retrying a dead letter waits for audited repair" note points to `durable dead-letters retry`.
- Subscription skip (ADR 0026 question 6) is the `subscriptions.skip` action, audited like a repair.

## Verification

`conformance/operator.ts`, on PGlite and Postgres:

- `refuses an application credential on every operator route and repairs nothing` (the failure row).
- `refuses a grant outside its action or resource scope, audits the denial, and changes nothing`.
- `inspects an actor with receipt tags only, and outcomes only under receipts.read`.
- `reads a success and a declared-failure outcome under a receipt-scoped grant without running the handler` (the operator half of **Receipt access without re-execution**).
- `retries a dead letter as a new effect and records operator, scope, reason, and the new effect id in the same transaction`.
- `refuses to retry an ambiguous dead letter until the operator states the provider was checked`.
- `discards a dead letter with its audit row and never records its payload`.
- `rolls the repair back when its audit row cannot be written`.
- `lets one of two concurrent repairs of a dead letter through` (real Postgres only).
- `lists defects only under defects.read, for the grant's tenants`.
- `lists a failing row with its lag and last error for an operator, and drops it once skipped` (`conformance/subscriptions.ts`, real Postgres).

`apps/cli` tests drive `durable inspect`, `durable receipts show`, `durable dead-letters retry|discard`, and `durable defects list` against `Operators.serve`.

## Revisit when

- Operators need time-bound or approval-gated grants (two-person repair).
- Tenant moves join the operator actions.
- Operators ask for a runtime-enforced audit retention policy; until then the runtime never prunes audit rows.
