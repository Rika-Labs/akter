# Background work and external effects

**Responsibility:** define activities, jobs, workflows, timers, and provider calls.  
**Authority:** normative.  
**Owner role:** reliability/runtime.  
**Change policy:** provider support requires a written adapter contract and fault tests.

Activities perform bounded external operations. Jobs provide isolated throughput work. Workflows persist time, steps, signals, and recorded results. Timers enqueue future commands. None retain a command transaction.

External effects use stable logical identities. An adapter may claim deduplicated outcomes only when provider idempotency, transactional handoff, or reliable reconciliation covers the retry and restore horizon.

Cancellation may stop local work; it cannot undo a provider call or already-written bytes. Unknown outcomes require reconciliation before unsafe retry.
