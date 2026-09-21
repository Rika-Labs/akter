# Transaction catalog

**Responsibility:** show which facts share a commit boundary.  
**Authority:** design.  
**Owner role:** storage/runtime.
**Change policy:** a change that alters a contract guarantee requires an ADR.

| Operation             | In the turn transaction                                                                    | After commit                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Command               | generation fence, receipt, dirty keyed state, actor-table writes, events, intents, effects | reply and wake notification                                                                               |
| Postgres intent       | `cluster_messages` row                                                                     | target delivery                                                                                           |
| Neki intent           | tenant-shard `actor_outbox` row                                                            | relay to `cluster_messages`, then target delivery                                                         |
| Timer / cron          | durable delayed intent and receipt                                                         | due delivery; singleton cron has one cluster owner                                                        |
| Effect                | effect record and policy metadata                                                          | executor retry, then dead letter and actor hook                                                           |
| Workflow start/cancel | owner-scoped intent                                                                        | workflow engine transition                                                                                |
| Workflow activity     | no originating actor-turn mutation; actor calls use their own turns                        | workflow engine records identity/results around activity execution; provider I/O holds no actor turn open |
| Event                 | ordered event row                                                                          | streams, waits, and subscribers observe it                                                                |
| Blob                  | actor-scoped blob mutation                                                                 | transport of committed bytes                                                                              |
| Connection broadcast  | durable changes, if any                                                                    | frame flush; parked socket may wake activation                                                            |

No transaction remains open while waiting for another actor, a workflow activity, timer, socket, or external provider. A failure before commit delivers none of the staged consequences.

The workflow-activity row describes engine persistence, not a continuation of the actor transaction that requested the workflow. Connection frames requested by a turn flush after commit but remain best-effort; durable replay requires an event. Blob mutation means database `bytea` writes, not a network upload to an external provider.
