# Glossary

**Responsibility:** keep vocabulary consistent across agents and packages.  
**Authority:** normative terminology.  
**Owner role:** product/runtime architecture.

- **Actor:** durable application boundary around an identity and its mutation authority.
- **Address:** project, tenant, actor type, and actor ID.
- **Activation:** disposable in-memory process representation of an actor.
- **Generation:** fenced authority epoch for an activation.
- **Turn:** one bounded command execution and its transaction.
- **Command:** authenticated request addressed to one actor.
- **Receipt:** durable record of one logical command identity and outcome.
- **Message:** durable command delivery between actors.
- **Event:** committed fact available for delivery or replay.
- **Intent:** durable request for work after the current transaction commits.
- **Activity:** bounded work that may perform external I/O.
- **Job:** throughput-oriented background execution.
- **Workflow:** durable orchestration of time, steps, signals, and recorded results.
- **Owner:** actor authority allowed to mutate a row or aggregate.
- **Transfer:** protocol that changes mutation authority without dual writers.
- **Snapshot:** authorized initial state for a subscription.
- **Cursor:** opaque position after a snapshot or event boundary.
- **Signal:** ephemeral, best-effort realtime input or output.
- **Presence:** leased connection/member state, not durable business truth.
- **Live query:** authorized query subscription with refresh or incremental updates.
- **Unknown:** outcome not yet determined after an ambiguous external boundary.
- **Hibernation:** removal of activation-local resources while identity and gateway state remain durable.
