# API naming

**Responsibility:** keep public terminology deliberate.  
**Authority:** API design.  
**Owner role:** API/SDK.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

Settled names:

- `Actor.make`, `Actor.command`, `Actor.query`, `Actor.stream`, `Actor.connection`, `Actor.workflow`
- `X.get`, `X.create`, `Actors.mint`
- `X.toLayer`, `X.toQueryLayer`
- `Actors.layer` from `durable-actors/runtime`
- `Actor.serve`, `Actor.auth`
- `ActorTest`, `test.actor`, `test.create`
- `ctx.rows`, `ctx.db`, `ctx.state`, `ctx.vars`
- `ctx.emit`
- `ctx.perform`
- `ctx.self`, `ctx.actors`
- `ctx.connections`
- `ctx.caller`, `ctx.principal`
- `Hibernate`, `Lifecycle`, `Connections`, `Mailbox`, `Delivery`, `Commands`, `Receipts`, `Defects`, `Effects`, `Events`, `State`, `Cron`, and their `Policy` aggregate
- `Actor.table`, `Actor.blob`, `Actor.migration`, `ctx.blob`, and `Turn`

An actor is always made with `Actor.make`; specialized actor constructors and standalone workflow constructors do not exist. Cron is a policy on an actor command. Runtime construction is plural because it supplies the `Actors` service.
