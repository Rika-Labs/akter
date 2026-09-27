# Observability

**Responsibility:** make behavior explainable in production.  
**Authority:** operational.  
**Owner role:** operations/reliability.
**Change policy:** a change requires operator review when a procedure or limit changes.

Cluster RPC spans are named `durable-actors.<Actor>/<Command>`. Trace context travels in the envelope so dispatch, turn execution, intents, effects, workflows, and replies remain one trace.

Turn spans and logs include deployment, tenant, actor type, actor id, command, command id, caller, generation, trigger, and receipt replay status. The command id is also the HTTP `x-request-id`, linking client errors to receipts and server logs. Redact bearer tokens, API keys, database URLs, private payloads, and provider credentials.

Monitor command latency, mailbox depth and age, receipt replay rate, generation-fence failures, lock timeouts, redelivery, transaction retries, actor restarts, singleton ownership, cron lateness, workflow age, effect retries and dead letters, parked connections, database saturation, and restore progress. On hosted Neki also monitor relay lag, duplicate suppression, and stranded `actor_outbox` rows.

Bound actor-id and tenant cardinality in metrics; use traces and logs for individual identities. Alert on degraded recovery paths, not only failed requests: relay backlog, old dead letters, repeated deterministic defects, and a singleton without an owner are operational failures.

Committed runtime state is readable from SQL through the read-only `durable` [inspection views](inspection-views.md) (migration `0013_inspection_views`, [ADR 0028](../decisions/0028-sql-inspection-views.md), proposed): actors, state, receipts, events, outbox, timers, effects, and dead letters. Dashboards and tools read those views under a role granted only the `durable` schema, never the `actor_*` tables. The planned `durable dead-letters` command will expose inspection and repair under the effect policy and [runbooks](runbooks.md); the command is not implemented. Never infer success solely from an executor attempt; use the durable effect outcome. These observability requirements also remain implementation targets, not existing telemetry guarantees.
