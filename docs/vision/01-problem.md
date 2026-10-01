# 01 — The problem

**Responsibility:** define the problem, customer promise, and product intent.  
**Authority:** product intent.  
**Owner role:** product direction.  
**Change policy:** a change requires product sign-off and a matching contract update when a promise shifts.

## Vision

Important application concepts—rooms, documents, accounts, devices, orders, and agents—have identity, mutable state, live clients, and work that must survive failure. Teams usually assemble those concepts from HTTP handlers, SQL, locks, retries, schedulers, background processes, and WebSockets. Correctness then lives in the gaps between systems.

Durable Actors makes the application concept the coordination boundary. One actor owns an identity, serializes its commands, commits relational facts, and continues work after a process disappears.

## The customer promise

> Build stateful, realtime applications without hand-building the distributed-systems glue.

An actor can:

- receive typed commands and expose typed reads;
- own keyed state and relational business rows;
- emit durable events with a cursor;
- run workflows, schedules, timers, and external calls;
- hold typed connections and broadcast live hints;
- hibernate and rebuild its activation;
- attribute work to the caller its transport authenticated, and let each actor decide who may use it;
- remain inspectable in Postgres and ordinary observability tools.

## Product intent

Durable Actors is an Effect-native actor framework. It is not a workflow-only product: workflows are members of the actor that owns their identity and data. It is not a separate background-work product: scheduling and jobs are consequences of actor turns. It has no AI-specific product surface; an agent is simply an actor, and contract-derived OpenAPI is available to external tool generators.

## We are not building

- a private replacement for relational data;
- a hosted-only platform;
- arbitrary JavaScript continuation checkpointing;
- hostile-code isolation;
- globally atomic distributed application logic;
- exactly-once outcomes from external providers that offer no idempotency or reconciliation mechanism.

See [the product model](02-product-model.md) for the unit that replaces this glue and [boundaries](08-boundaries.md) for the guarantees we refuse to blur.
