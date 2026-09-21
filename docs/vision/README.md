# Durable Actors vision

**Responsibility:** index the vision documents and their reading order.  
**Authority:** product intent.  
**Owner role:** product direction.  
**Change policy:** a change requires product sign-off and a matching contract update when a promise shifts.

These documents state the settled v4 product intent: an Effect-native durable actor framework with relational data, realtime connections, durable execution, strong testing, and three deployment modes. They describe why the product exists, what developers should believe, and where its guarantees stop; they are not claims that every surface is already implemented.

## Reading order

1. [The problem](01-problem.md)
2. [The product model](02-product-model.md)
3. [Relational data](03-relational-data.md)
4. [Durable execution](04-durable-execution.md)
5. [Realtime applications](05-realtime.md)
6. [Developer experience](06-developer-experience.md)
7. [Deployment and ownership](07-deployment.md)
8. [Boundaries](08-boundaries.md)

## Through-line

`Actor.make` is the one primitive. An actor owns identity and serialized mutation; keyed state and `OwnedTable` rows commit with receipts and events; workflows are actor members; cron, timers, and effects continue work; typed connections provide realtime behavior; `Actors.layer`, `Actor.serve`, and hosted runners provide embedded, served, and hosted operation.

The product is actor-first. It does not split application behavior into unrelated infrastructure products, and it does not introduce an AI-specific surface. The reference examples—counter, chat, and coding agent—must prove the model end to end.

Implementation contracts live in the framework and architecture documentation. Research records explain how the design was reached; settled vision takes precedence over superseded proposals.
