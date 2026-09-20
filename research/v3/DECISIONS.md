# Decisions and unresolved contracts

## Precedence

The user's latest requirements override older architecture proposals. Historical documents contain assistant-selected defaults, not a blanket record of user approval. Feature inclusion and implementation certainty are separate axes.

## Accepted product scope

| Decision | Consequence |
| --- | --- |
| Effect-native framework; ordinary TypeScript SDK derived from it | One handler/runtime implementation and one protocol contract |
| First-class Drizzle semantics and re-exports | No proprietary SQL builder; an Effect-aware adapter is still needed |
| One actor context with `ctx.*` | Framework capabilities are accessed consistently; application services remain Effect services |
| One `ctx.database` name | Permissions and transaction scope depend on execution phase |
| State observable by default | No compulsory public-view declarations or projection pipeline |
| Automatic actor write ownership | No per-query `.owned()` or manual ownership filters as the safety mechanism |
| Wrong-owner mutations should error | Types catch static misuse; dynamic ownership requires a proven runtime contract |
| Live activations, derived read models, actor-integrated realtime | Connections/background work can outlive a short turn; caches are not truth |
| BlobStore, jobs, activities, workflows retained | Rejecting standalone workflow/job adoption did not remove actor-supporting work |
| Timers and recurring work retained | Durable scheduling, without a generic exactly-once wall-clock promise |
| OSS, local testing, same runtime model | No mandatory vendor control plane or alternate production-only semantic runtime |
| Ordinary Postgres self-hosting; Neki public cloud | Actor-local Neki transactions, not global transaction equivalence |
| Managed private/BYOC | Product capability, not an MVP prerequisite |
| Provider-aware external effects | Exactly-once outcomes only under an adequate external protocol |
| Ownership transfer | Explicit coordinator/protocol, not changing an ownership column with normal SQL |
| Live SQL including incremental maintenance | In scope; supported query algebra and change source must be defined |
| Connection-preserving hibernation | Connections can survive activation sleep; gateway failure can still disconnect them |

## Removed or superseded

- Cloudflare Durable Objects as the runtime substrate; Turso/private SQL database per actor as our storage model.
- Mandatory projections or explicitly published views before business state can be observed.
- Separate `Realtime.forActor(...)` registration.
- Separate `yield* State` and `yield* Database` as required handler ceremony; nested `.db` and repeated `.execute(...)` plumbing.
- Per-query ownership opt-in via `.owned(...)` as the normal user experience.
- Standalone hosted functions, jobs, or workflows as a separate product/adoption strategy.
- Enlarging actor transaction boundaries to combine unrelated entities solely for cross-entity ACID.
- Required shared Redis cache or Kafka/SQS hot path; caches remain derived and new infrastructure must earn its cost.
- Historical certainty about fixed 300 hash buckets, Neki RLS, global snapshots, or PGlite concurrency equivalence.

The source thread's optional Cloudflare edge adapter was not a requirement. A self-hostable connection gateway cannot depend on that adapter.

## Not settled by the latest approval

- Bulk command transport versus multiple commands in one transaction; no multi-command atomicity promise.
- Extreme sparse-workload optimization, millions-of-idle-actor pricing/performance claims.
- Transparent intra-actor concurrent mutation turns.
- Exact OSS license, package names, minimum runtime versions and peer-dependency ranges.
- Physical tenancy isolation (database/schema/row policies), generated ownership-column layout, actor ID encoding and shard key.
- Default retry counts, retention periods, timer replacement/cancellation semantics, missed cron tick policy.
- Global placement, automatic actor relocation across regions and nearest-on-create routing.
- Exact transferable aggregates, live-SQL support matrix and provider-adapter support matrix.

## Contracts that must be resolved before claiming support

### One query name does not imply one authority

Command `ctx.database` is actor-local and transaction-bound. Application/query `ctx.database` is authorized shared read-only access. Background work cannot retain a command transaction. Raw SQL and directly imported database clients do not acquire safety from TypeScript imports.

### Ownership errors versus implicit scoping

The user wants both no manual ownership ceremony and errors when a mutation targets a foreign row. The earlier conversation proposed conflicting interpretations for broad SQL. This spec does not quietly choose one.

| Operation | Required decision / test |
| --- | --- |
| Insert business row | Ownership stamped automatically; no caller-chosen foreign owner |
| Update own row by runtime ID | Succeeds, preserving ownership |
| Update visible foreign row by runtime ID | Explicit ownership rejection desired, not a partial write |
| Target absent or unauthorized row | Non-disclosing failure; no cross-tenant existence oracle |
| Update without WHERE / with broad predicate | Decide actor-scoped meaning versus all-matching-rows rejection before shipping |
| Mixed-owner bulk update / upsert / join / cascade / raw SQL | Define support and prove no partial effects or bypass |

Postgres RLS can filter UPDATE/DELETE rows to zero rather than throw. A visibility precheck without locking is racy. Unrestricted cross-shard prechecks are incompatible with an actor-local Neki turn. Neither an SQL parser nor a mutable transaction setting is a hostile-code sandbox. Unsupported forms must be rejected explicitly, not advertised as safe.

### Advanced capabilities have bounded guarantees

- External effects: request replay is allowed; deduplicated external outcome depends on provider atomicity, identity retention and reconciliation. Unknown is a real result.
- Transfer: one writable owner; cross-shard transfer can be temporarily unavailable. Shared observations may see transitional data unless the read contract excludes it.
- Live SQL: no universal incremental SQL engine is promised; deterministic supported query forms need a published matrix. Rerun subscriptions do not emit every intermediate state.
- Hibernation: gateway retains the socket, not arbitrary actor fibers. Gateway loss and browser/network changes require reconnect.

## Example API choices are proposals

Feature documents use concrete names to make the experience reviewable. They do not settle every naming detail. For example, `ctx.jobs.start`, `ctx.blobs.presign`, and `ctx.database.watch` may change without changing the product decision. No separate runtime is introduced by having different context types.
