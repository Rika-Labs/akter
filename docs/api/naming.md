---
title: "API naming"
sidebarTitle: "Naming"
description: "The settled names of Akter's public API."
---

# API naming

**Responsibility:** keep public terminology deliberate.  
**Authority:** API design; on `rewrite/0.2` these are the 0.2 names of [ADR 0128](../decisions/0128-constrained-actor-api.md), a proposal until E1 and E4 land.  
**Owner role:** API/SDK.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

Settled names for 0.2:

- `Actor.make(name, { key?, state, actions, views?, events?, jobs?, presence?, access? })`
- Constructors: `Actor.action(payload?, { success?, fails?, cron? })`, `Actor.view(success, { params? })`, `Actor.event(schema)`, `Actor.job({ payload, retry?, timeout?, concurrency?, onFailure })`, `Actor.list(item, { key?, by })`; one argument order everywhere: schema first, options second
- Values: `Actor.JobFailure`
- List operations in actions: `put`, `get`, `delete`, `range`, `deleteBefore`
- Action context: `caller`, `now`, `id`, `random`, `self`, `send(Target, id).<action>`, `schedule(durationOrDate).<action>`, `start.<job>`, `emit.<event>`, `connection`
- Job context: `self`, `step`, `emit`, `id`, `attempt`
- Implementation: `X.toLayer({ ...actions, ...views, ...jobs, connect?, disconnect? })`
- Client: `X.client(id)` with each action, `state`, each list's `range`, each view, each event and `join`; static `X.find({ where, orderBy, limit })`
- Server: `Akter.serve({ auth })`, `Store.s3({ bucket, prefix? })`, `Store.fileSystem(dir)`, `Store.memory()`, `App.make`
- Testing: `Simulation.layer`, `Simulation.seed`, `Simulation.settle`, `Simulation.state`
- CLI: `akter dev`, `akter inspect actor`, `akter inspect shard`, `akter log tail`, `akter log export`, `akter snapshot`, `akter fork`, `akter replay`, `akter storage check`

An action's key in `actions` is also its handler key and its client method. There is one name per concept and one way to do each task; a second spelling exists only when it changes outcomes materially.

An actor is always made with `Actor.make`, and its contract is its only shape. Constructors never make actors. Recurring work is the `cron` option of an action, not a section.

## Replaced names

| 0.1 name                                                  | 0.2 name                                |
| --------------------------------------------------------- | --------------------------------------- |
| command, reducer                                          | action                                  |
| query, watch, `X.toQueryLayer`                            | `state`, list `range`, view             |
| table, blob, content                                      | list                                    |
| workflow, executor, `X.toJobLayer`                        | job, step, `X.toLayer`                  |
| `X.intents`                                               | `ctx.send`, `ctx.schedule`              |
| `X.get`, `X.create`                                       | `X.client`                              |
| feed, stream, connection member                           | event, state stream, `join`             |
| `Fleet.view`                                              | `X.find`                                |
| `schedules`, `policy.cron`                                | `cron` action option                    |
| `ActorTest`                                               | `Simulation`                            |
| `Actors.layer`, `Actors.serve`, `@rikalabs/akter/runtime` | `Akter.serve`, `@rikalabs/akter/server` |
| `@rikalabs/akter/cold-storage/s3`                         | `Store.s3` in `@rikalabs/akter/server`  |
| `@rikalabs/akter/client`                                  | the Effect client in `@rikalabs/akter`  |
