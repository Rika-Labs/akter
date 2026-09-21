# 02 — The product model

**Responsibility:** define the actor primitive and its execution model.  
**Authority:** product intent.  
**Owner role:** product direction.  
**Change policy:** a change requires product sign-off and a matching contract update when a promise shifts.

## Vision

An actor is an identity plus serialized mutation under one transaction. `Actor.make` is the only actor constructor. Its contract may declare commands, queries, streams, connections, workflows, events, effects, tables, blobs, keyed state, per-activation `vars`, migrations, and lifecycle policies.

Actors may use framework-minted ids, application-defined names, or `singleton: true`. `Cron.every` schedules a command on the same actor. `Hibernate.after` lets an idle activation sleep. `Connections.park` lets the activation hibernate while WebSocket-style connections remain parked and can wake it.

## The turn model

```text
command → generation fence → receipt → handler → commit
```

These steps run in one database transaction. The commit may include keyed state, OwnedTable rows, events, timers, actor intents, workflow intents, effect obligations, and the receipt. A retained receipt makes retrying the same command id replay the logical result instead of applying the handler twice. Declared application failures are recorded and replayed too.

Outside a command turn, state is read-only. `ctx.state` is a `StateSnapshot`; its `changes` stream publishes committed snapshots. `vars` are typed activation-local values and deliberately disappear when the activation hibernates.

## One primitive, several modes

- A durable domain object declares the state and members it needs.
- A transient coordination actor can declare only `vars`; its commands remain serialized and fenced, but it has no declared durable data.
- A cluster-wide service uses `singleton: true`.
- A finite durable operation is an `Actor.workflow` member of its owning actor.

An activation is not the actor. Processes may stop, move, or restart while identity, committed data, receipts, events, and future obligations remain.

## Authority

Actors own mutation, not all visibility. Commands are the normal write boundary for actor-owned data. Authorized services may read relational data across actors for reporting and operations without acquiring mutation authority.

See [relational data](03-relational-data.md), [durable execution](04-durable-execution.md), and [realtime](05-realtime.md).
