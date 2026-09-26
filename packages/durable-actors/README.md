# @durable-actors/core

An Effect-native actor framework with durable identity, transactional turns, and ordinary relational data. One database per deployment, not per actor.

> **Alpha, single runner.** Run one runtime process per database: multi-runner operation is not supported yet. APIs and stored formats may change between alphas without a migration path.

## Install

The runtime needs [Bun](https://bun.sh) 1.4.2 or later and Postgres (or PGlite for tests).

```sh
bun add @durable-actors/core@alpha
```

| Entry                          | Responsibility                                                      |
| ------------------------------ | ------------------------------------------------------------------- |
| `@durable-actors/core`         | Actor contracts, members, policies, identity, errors, and handles.  |
| `@durable-actors/core/runtime` | `Actors.layer`, database integration, and migrations.               |
| `@durable-actors/core/client`  | The browser-safe Promise client (a placeholder in this alpha).      |
| `@durable-actors/core/testing` | `ActorTest`, fault hooks, and the shared backend conformance suite. |

See the [repository](https://github.com/Rika-Labs/durable-actors#readme) for the API, contracts, and a runnable counter example, and [CHANGELOG.md](CHANGELOG.md) for what this release contains.

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`.
