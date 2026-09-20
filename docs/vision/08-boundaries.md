# 08 — Boundaries

## Vision

Durable Actors should be ambitious about removing coordination work and conservative about guarantees it cannot enforce.

## We should promise

- durable actor identity;
- actor-controlled mutation;
- transactional local turns;
- recoverable commands and work;
- typed messaging and realtime contracts;
- relational observation for authorized readers;
- self-hostable operation;
- clear failure and recovery state.

## We should not promise by default

- global cross-actor transactions;
- a globally consistent snapshot across shards or regions;
- arbitrary SQL incremental maintenance;
- exactly-once effects against arbitrary providers;
- automatic relocation with no availability tradeoff;
- infinite idle-actor scale at a fixed cost;
- arbitrary JavaScript continuation checkpointing;
- hostile-code isolation;
- one hot actor scaling linearly across workers.

When a workload needs one of these, the framework should explain the boundary and offer a deliberate alternative rather than quietly providing a weaker guarantee.
