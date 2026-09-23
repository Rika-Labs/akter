# Operator runbooks

**Responsibility:** provide repeatable recovery actions.  
**Authority:** operational.  
**Owner role:** operations/reliability.
**Change policy:** a change requires operator review when a procedure or limit changes.

Every incident procedure records symptoms, deployment and tenant scope, command or execution ids, relevant traces, safe actions, forbidden actions, and recovery proof.

These are design requirements for future runtime operations, not runnable procedures for the current scaffolds. In particular, the `durable` CLI commands are not implemented.

| Incident                        | Safe first actions                                                                             | Recovery proof                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Mailbox backlog                 | reduce ingress, inspect oldest envelopes and runner health, add verified shard capacity        | age and depth fall without duplicate application                                                                                  |
| Fence or lock failures          | inspect generation owner and database locks; drain a stale runner                              | new turns commit under one generation                                                                                             |
| Deterministic defect            | inspect the `X.onDefect` cause, state migration, and input; deploy a code/schema fix           | same command succeeds or returns a declared error                                                                                 |
| Retryable redelivery loop       | inspect dependency, timeout, and activation restarts                                           | one receipt is committed and replayed                                                                                             |
| Effect dead letter              | inspect provider outcome and idempotency key; repair through the planned dead-letter interface | durable success or explicit discard with audit reason                                                                             |
| Neki relay backlog              | keep ingress bounded, restore relay health, inspect stranded outbox rows                       | every committed obligation reaches one logical destination intent; receiver receipts deduplicate redelivery                       |
| Singleton missing or duplicated | verify sharding reachability and ownership, drain conflicting runner                           | one `run` owner and one cron tick across two runners                                                                              |
| Parked-socket storm             | rate-limit reconnects and inspect edge/runners                                                 | activation wake restores parked state; transport loss reconnects and replays durable events without pinning all activations awake |
| Failed migration                | stop rollout, retain old readers, restore or apply forward repair                              | conformance and state decode pass                                                                                                 |
| Tenant isolation incident       | stop affected ingress, preserve evidence, rotate credentials, audit RLS and predicates         | cross-tenant probes fail and affected rows are reconciled                                                                         |
| Restore                         | follow [backup and restore](04-backup-restore.md)                                              | receipts, effects, workflows, relay, and singleton checks pass                                                                    |

Never delete receipts, generation rows, messages, outbox rows, or dead letters as a first-line fix. Escalate with trace ids, command ids, SQL evidence, deployed versions, and the exact recovery test.
