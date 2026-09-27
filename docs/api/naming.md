# API naming

**Responsibility:** keep public terminology deliberate.  
**Authority:** API design.  
**Owner role:** API/SDK.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

Settled names ([ADR 0010](../decisions/0010-one-way-effect-native-api.md)):

- `Actor.make`, and its definition sections `key`, `placement`, `state`, `tables`, `blobs`, `events`, `effects`, `api`, `internal`, `policy`
- Members: `Actor.command`, `Actor.reducer`, `Actor.query`, `Actor.stream`, `Actor.connection`, `Actor.workflow`, `Actor.state`, `Actor.table`, `Actor.blob`, `Actor.Event`, `Actor.effect`, `Actor.singleton`, `Actor.DeadLetter`
- Handles: `X.get`, `X.create`, `X.intents`, and `Intent.after`, `Intent.at`, `Intent.key`, `Intent.cancel`
- Layers: `X.toLayer`, `X.toQueryLayer`, `X.toEffectLayer`
- Context services: `X.Turn`, `X.Read`, `X.Connection`, `X.Workflow`, `X.Executor`, and the runtime marker `Actor.InTurn`
- Ambient scope: `Actor.as`, `Actor.tenant`, `Actor.commandId`
- Fleet reads: `Fleet.view`, `Fleet.subscribe`
- `Actors.layer` from `@durable-actors/core/runtime`
- `Actor.serve`, `Actor.auth`
- `ActorTest`, `test.actor`, `ActorTest.simulate`

A command's PascalCase tag is also its `api` key, handler key, and handle method. There is one name per concept and one way to do each task; a second spelling exists only when it changes outcomes materially.

An actor is always made with `Actor.make`, and its definition is its only shape. Member constructors never make actors. Cron is a policy on an actor command. Runtime construction is plural because it supplies the `Actors` service.
