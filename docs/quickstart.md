# Quickstart

**Responsibility:** take a developer from an empty directory to a running, tested actor app.  
**Authority:** operational.  
**Owner role:** API / SDK.  
**Change policy:** change with `packages/create/templates`; the CI quickstart smoke runs every command here except the npm install.

You need [Bun](https://bun.sh) 1.4.2 or later. No Docker and no database server: the app stores its data with [PGlite](https://pglite.dev), an embedded Postgres, in `./.data`.

## 1. Create the app

```sh
bun create @durable-actors my-app            # a counter
bun create @durable-actors my-chat --template chat
cd my-app
bun install
```

`bun create @durable-actors` runs the `@durable-actors/create` package, which is not on npm until the `0.1.0-alpha` release ([#99](https://github.com/Rika-Labs/durable-actors/issues/99)), and neither is `@durable-actors/core`. Until then, run it from a checkout and install the framework from a locally packed tarball:

```sh
git clone https://github.com/Rika-Labs/durable-actors.git && cd durable-actors
bun install --frozen-lockfile && bun run prepare
bun .github/src/pack.ts --out .local/package
npm pack .local/package --pack-destination .local
bun packages/create/src/main.ts ../my-app
cd ../my-app
bun add @durable-actors/core@file:../durable-actors/.local/durable-actors-core-0.1.0-alpha.0.tgz
bun install
```

## 2. Run it

```sh
bun start   # visits: 1
bun start   # visits: 2
```

Each run is a new process. The count survives because the turn that incremented it committed to the database files in `./.data` before the reply. Delete `./.data` to start again. The chat template posts a message and prints the room's event history, one line longer each run.

## 3. Test it

```sh
bun test
```

The tests use `ActorTest` from `@durable-actors/core/testing`, which runs the real turn path, and a throwaway PGlite directory:

- a retried command replays its receipt rather than running twice;
- a crash before or after commit leaves exactly one increment;
- state survives a restart of the same wiring `src/main.ts` uses.

The chat template also checks that a declared failure (`RoomClosed`) rolls back the turn's rows and events.

## 4. Where things are

| File                        | What it holds                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `src/counter/contract.ts`   | The actor: key, state schema, and `Increment` command. Clients import only this.         |
| `src/counter/layer.ts`      | The handler. It reads and sets state through `Counter.Turn` inside one transaction.      |
| `src/database.ts`           | Picks the database: Postgres when `DATABASE_URL` is set, otherwise PGlite in `DATA_DIR`. |
| `src/main.ts`               | Builds the runtime with `Actors.layer()` and sends one command as the process caller.    |
| `src/counter/layer.test.ts` | Retry, crash, and restart tests.                                                         |

Chat keeps the same shape under `src/room/`, with an owned Drizzle table, events, a reducer, queries, and a declared error. [`examples/chat`](../examples/chat) goes further, with blobs, effects, and retention.

## 5. Switch to Postgres

```sh
DATABASE_URL=postgres://user:password@localhost:5432/my_app bun start
DATABASE_URL=postgres://user:password@localhost:5432/my_app bun test
```

Startup creates the framework tables. Use a database for this app alone; the tests create a fresh tenant per run inside it.

## What PGlite is for

PGlite in the generated app is for development and single-process use. It has one connection and belongs to the one process that opened `./.data`, so:

- run one process against a data directory; a second process opening it at the same time is unsupported;
- nothing on PGlite proves lock contention, independent connections, multi-runner relay, or process-kill recovery, which the framework verifies on Postgres only;
- File-backed PGlite is a production backend for one process per data directory, within the limits of [ADR 0035](decisions/0035-pglite-embedded-production-backend.md): the data directory is locked to one process, a process crash recovers to the last commit (power loss is not claimed), backups are stopped copies, and there are no replicas or multiple runners. Set `DATABASE_URL` to move to Postgres when those limits bind; see the [support matrix](operations/support-matrix.md).

On Postgres the app is still alpha and single-runner: run one runtime process per database.
