# 02 — The product model

**Responsibility:** define the actor primitive and its execution model.  
**Authority:** product intent.  
**Owner role:** product direction.  
**Change policy:** a change requires product sign-off and a matching contract update when a promise shifts.

## Vision

An actor is an identity plus serialized mutation under one transaction. `Actor.make(name, definition)` is the only way to make an actor. Its definition declares `key`, `placement`, `state`, `tables`, `blobs`, `events`, an `api` of commands, reducers, queries, streams, connections, and workflows, `internal` commands, `createdBy`, `schedules`, `jobs`, `subscriptions`, `policy`, and `access`. There is one way to do each task ([ADR 0010](../decisions/0010-one-way-effect-native-api.md)).

Actors may use framework-minted ids, application-defined names, or `Actor.singleton`. `schedules` runs a command on the same actor. `policy.hibernateAfter` lets an idle activation sleep, and parked WebSocket-style connections can wake it.

## The turn model

```text
command → generation fence → receipt → handler → commit
```

These steps run in one database transaction. The commit may include keyed state, OwnedTable rows, events, timers, actor intents, workflow intents, job obligations, and the receipt. A retained receipt makes retrying the same command id replay the logical result instead of applying the handler twice. Declared application failures are recorded and replayed too.

Outside a command turn, state access is read-only through `X.Read`. Workflow bodies and job executors act on actors through handles rather than a direct state capability. Activation-local values live in the layer's build closure and deliberately disappear when the activation hibernates.

## One primitive, several modes

- A durable domain object declares the state and members it needs.
- A transient coordination actor declares no state and keeps activation-local values in its layer; its commands remain serialized, fenced, and receipted.
- A cluster-wide service uses `key: Actor.singleton`.
- A finite durable operation is an `Actor.workflow` member of its owning actor.

An activation is not the actor. Processes may stop, move, or restart while identity, committed data, receipts, events, and future obligations remain.

## Authority

Actors own mutation, not all visibility. Commands are the normal write boundary for actor-owned data. Authorized services may read relational data across actors for reporting and operations without acquiring mutation authority.

See [relational data](03-relational-data.md), [durable execution](04-durable-execution.md), and [realtime](05-realtime.md).
