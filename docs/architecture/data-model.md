# Durable data model

**Responsibility:** define the durable records required by the runtime.  
**Authority:** design.  
**Owner role:** database/runtime.
**Change policy:** a change that alters a contract guarantee requires an ADR.

Framework-private records include:

| Record               | Purpose                                                                                                                                                                                      | Authority                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Generation           | fenced current writer                                                                                                                                                                        | turn admission                       |
| Receipt              | command id, input identity, stored exit                                                                                                                                                      | retry safety                         |
| `actor_state`        | compressed keyed schema values                                                                                                                                                               | small actor state                    |
| Actor table row      | relational actor-owned data                                                                                                                                                                  | application state                    |
| Event                | ordered committed publication                                                                                                                                                                | replay and waits                     |
| Effect / dead letter | post-commit external consequence                                                                                                                                                             | effect recovery                      |
| Workflow step        | recorded activity, clock, and deferred exits on the owner's shard                                                                                                                            | workflow recovery                    |
| `actor_connections`  | open connection or watch (`$watch:<Query>`): member, holder and epoch, caller, session, frame sequence                                                                                       | socket resumption, broadcast routing |
| Blob                 | large actor-scoped bytes                                                                                                                                                                     | application state                    |
| Subscription         | per-source subscription row with settled cursor on the source's shard; applied cursor on the subscriber's shard                                                                              | subscription delivery                |
| `actor_outbox`       | intents, timers, workflow starts, effects, subscription feeds and controls; effect `running`, `cancelled_at_ms`, `maybe_applied`, `ready_at_ms`, `waiting` (`0015_effect_control`, ADR 0024) | delivery and recovery                |

An `actor_outbox` effect row's `final_failure` (`0016_final_effect_failures`) records that an attempt's failure ended the effect, possibly before its retries ran out, as after a result its `onSuccess` route rejects. A claim that finds it set retries only the dead letter, whatever the retry policy, and the letter reports `attempts`. `scheduled_at_ms` (`0011_relay`) is required on every row, and `ready_at_ms` on every effect row.

One Postgres database belongs to each deployment region. Commands are direct: the receipt is their only durable record, and there is no command message table. `tenant_id` appears on every framework and actor-owned table, with optional RLS. Actor state, tables, events, effects, blobs, and receipts share the actor ownership key and transaction boundary.

Receipts retain original logical-caller attribution for result access without adding caller identity to their tenant/actor/command-id deduplication key. The command identity/admission design must also enforce external expiry after receipt pruning while preserving deduplication evidence for accepted internal work. Caller-key encoding and expiry enforcement records are not yet a concrete schema; see [ADR 0004](../decisions/0004-receipt-access-revocation-and-expiry.md) and [retention](../operations/retention.md).

State schemas evolve through the ordered migrations declared in `Actor.state(fields, { migrations })` during decode. Relational schemas evolve through drizzle-kit. Runtime records are not ordinary application mutation surfaces and have explicit retention and restore dependencies. Their public read surface is the read-only `durable` schema of [inspection views](../operations/inspection-views.md) (migration `0013_inspection_views`, [ADR 0028](../decisions/0028-sql-inspection-views.md)); the tables and any column the views leave out stay private.

Workflow identity is `[deployment, tenant, actor, id, workflow, key]`; in [ADR 0022](../decisions/0022-workflow-engine-storage-and-version-markers.md) the deployment is the database the row lives in, and the stored execution id encodes the rest. Singleton names and cron ownership are also deployment-scoped.
