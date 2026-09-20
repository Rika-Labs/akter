# v3 — The Durable Actors product specification

**Date:** 2026-09-20. **Predecessor:** [v2 feasibility assessment](../v2/README.md), with requirements recovered from the [v1 archive](../v1/README.md).

**Status:** accepted product direction plus proposed API and implementation designs. This is research, not an implemented SDK, measured performance claim, or passing conformance report. Research v3 is not a product release number.

> Define relational data with Drizzle. Mutate it through Effect actors. Observe it through SQL. Connect clients through realtime. Attach blobs and durable work to the same actor model.

The user approved adding provider-aware external effects, ownership transfer, live SQL (including incremental maintenance as a product capability), and connection-preserving hibernation. These are now **in scope**, not optional suggestions omitted from the product. Their supported domains and implementation strategies still need validation. Inclusion does not imply unlimited SQL support, unconditional exactly-once external effects, or immortal WebSockets.

## Read the specification

| Feature | What it owns |
| --- | --- |
| [01 Actor and context](features/01-actor-context/README.md) | One actor definition, Effect services, context capabilities, identity and tenancy |
| [02 Relational storage](features/02-relational-storage/README.md) | Drizzle, yieldable queries, shared observation, automatic row ownership |
| [03 Commands and messaging](features/03-commands-messaging/README.md) | Transactional turns, receipts, fencing, actor messages and queries |
| [04 Realtime](features/04-realtime/README.md) | Actor-declared subscriptions, snapshots, replay, presence and signals |
| [05 Lifecycle and read models](features/05-lifecycle/README.md) | Live activations, supervised work, passivation and derived caches |
| [06 Blob storage](features/06-blob-storage/README.md) | Actor-scoped objects, signed uploads, streaming and cleanup |
| [07 Background work](features/07-background-work/README.md) | Activities, jobs, workflows, worker pools and agent composition |
| [08 Timers and cron](features/08-timers-cron/README.md) | Durable future commands, recurring work and cancellation boundaries |
| [09 External effects](features/09-external-effects/README.md) | Conditional exactly-once outcomes, provider contracts and reconciliation |
| [10 Ownership transfer](features/10-ownership-transfer/README.md) | Explicit transfer of mutation authority, not ordinary SQL reassignment |
| [11 Live SQL](features/11-live-sql/README.md) | Authorized query subscriptions, refresh and incremental maintenance |
| [12 Connection hibernation](features/12-connection-hibernation/README.md) | Gateway-owned connections that outlive actor activations |
| [13 SDKs and transports](features/13-sdk-transports/README.md) | Effect and Promise clients, HTTP, WebSocket and SSE |
| [14 Deployment](features/14-deployment/README.md) | OSS Postgres self-hosting, Neki cloud and managed private deployments |
| [15 Operations and security](features/15-operations/README.md) | Dashboards, auth, migrations, CLI, observability, retention and recovery |
| [16 Testing](features/16-testing/README.md) | Local development and falsifiable conformance/failure gates |

Read [decisions and unresolved contracts](DECISIONS.md) before interpreting an example as a guarantee. [Sources](SOURCES.md) identify requirement provenance and inherited technical evidence.

## Architecture

```diagram
┌────────────────────────────────────────────────────────────────┐
│ Effect clients · TypeScript SDK · dashboards · HTTP/WS/SSE      │
└───────────────────────────────┬────────────────────────────────┘
                                ▼
┌────────────────────────────────────────────────────────────────┐
│ Auth / admission · connection gateway · live-query service      │
└──────────────┬───────────────────────────────────┬─────────────┘
               ▼                                   ▼
┌─────────────────────────────┐    ┌──────────────────────────────┐
│ Actor activation            │    │ Authorized shared SQL reads │
│ ctx + short command turns   │    │ dashboards / live queries    │
└──────────────┬──────────────┘    └──────────────┬───────────────┘
               ▼                                 ▼
┌────────────────────────────────────────────────────────────────┐
│ Postgres, or actor-local transaction domain on Neki             │
│ business rows · command receipts · events · timers · intents     │
└───────────────────────────────┬────────────────────────────────┘
                                │ post-commit delivery
                                ▼
┌────────────────────────────────────────────────────────────────┐
│ Activities / jobs / workflows · blob adapters · external APIs    │
└────────────────────────────────────────────────────────────────┘
```

These are logical responsibilities, not a mandate for a microservice per box. Local and small self-hosted deployments can colocate components. A hibernating actor's gateway must remain alive even when that activation is removed.

## Code-example convention

- All `durable-actors` exports, helper names, generated contracts, and context methods below are **proposed**. They are not installable or compiler-verified API claims.
- Standard Drizzle query syntax is retained, but making its builders directly Effect-yieldable requires an adapter. A re-export alone does not do it.
- Use `const ctx = yield* Context`, then `ctx.database`, `ctx.blobs`, etc. No `.state.db`, `.database.db`, `.owned()`, manual Promise wrapping, or `database.execute(database...)` in ordinary application examples.
- Realtime capabilities are declared on `Actor.define`, not registered using `Realtime.forActor`.
- `Context` differs by execution phase. A command has a turn-bound writer and durable-intent methods; a query has read access; an activity has external I/O capabilities. One name is not one unrestricted ambient object.
- Example schemas, authorization services, provider clients, and UI functions may be placeholders. Examples explain contracts; they are not complete production applications.
- Persisted business state is queryable by authorized readers by default. This does not expose credentials, other tenants' data, or privileged framework internals.

## What changed from v2

- Effect-first framework plus a derived ordinary TypeScript SDK; one semantic runtime.
- Drizzle-native developer experience and one contextual `ctx.database` name.
- Automatic ownership without per-query opt-in; the explicit wrong-owner error contract remains a required design gate.
- Realtime moved into the actor definition/context; live activations and versioned read models are included.
- Restored explicitly requested blobs, jobs, activities, workflows, local testing, and operational surfaces that recent examples omitted.
- Added the four newly approved advanced capabilities to the full product scope.
- Self-hosted uses ordinary Postgres; our public cloud uses PlanetScale Neki; managed private/BYOC is included as a deployment direction.

v2's feasibility limits still apply unless this iteration explicitly supersedes them. In particular, Neki compatibility, Effect/Drizzle transaction integration, ownership enforcement, and post-commit publication are **not proven**. No infrastructure was provisioned or deployed for this specification. v1 and v2 remain unchanged.
