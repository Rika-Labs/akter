# Testing

**Responsibility:** show how to test actors with `ActorTest`: the real turn path, crash points, time, and choosing a database for the test.  
**Authority:** operational.  
**Owner role:** verification.  
**Change policy:** change with the `/testing` entry of the [server API](../api/01-server-api.md#implemented-foundation-subset) and the quickstart templates in `packages/create/templates`.

`ActorTest` from `@rikalabs/akter/testing` runs your actors on the same turn, serialization, and storage path as production, against a real database. There is no in-memory fake of the runtime: a test that passes has committed the same rows the app would.

## A first test

This is the retry test from the quickstart's `counter` template (`src/counter/layer.test.ts`), which runs under `bun test`:

```ts
const harness = () =>
  ManagedRuntime.make(
    CounterLive.pipe(
      Layer.provideMerge(ActorTest.layer({ database })),
      Layer.provide(BunCrypto.layer),
    ),
  )

test("a retried command replays its receipt instead of counting twice", async () => {
  const runtime = harness()

  await runtime.runPromise(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const counter = yield* Counter.get("retry")
      const call = counter.Increment(2)

      expect(yield* call).toBe(2)
      expect(yield* call).toBe(2)
      expect(yield* test.inspect(counter.ref)).toMatchObject({ state: { count: 2 }, receipts: 1 })
    }),
  )
  await runtime.dispose()
})
```

`counter.Increment(2)` is one operation: its command id is minted on the first run and reused on the second, so the second run finds the receipt and returns the recorded `2` without running the handler. `test.inspect(ref)` reads what committed: the generation, the decoded state, the receipt count, and the pending outbox rows the actor sent.

`ActorTest.layer` builds a fresh tenant each time, so tests that share a database do not see each other's actors.

## Crashing a turn

`test.crashNext(point)` makes the next turn fail at a named point, as if the process died there:

```ts
yield * test.crashNext("beforeCommit")
expect(yield * counter.Increment(7)).toBe(7) // rolled back, retried with the same id, committed once

yield * test.crashNext("afterCommit")
const second = counter.Increment(3)
expect(yield * second).toBe(10) // committed, reply lost, retry found the receipt
expect(yield * second).toBe(10)

expect(yield * test.inspect(counter.ref)).toMatchObject({ state: { count: 10 }, receipts: 2 })
```

The turn points are `beforeDelivery`, `beforeHandler`, `beforeCommit`, and `afterCommit`. The relay's points are `afterClaim`, `beforeOutboxDelete`, `beforeExecute`, `afterExecute`, and `beforeRenew`, for intents and jobs. `test.pauseNext(point)` holds a turn at a point instead, so a test can act while it waits. `test.invalidate(ref)` bumps the actor's generation, as another runner taking ownership would, so the next turn from the old activation fails its fence and reloads.

Add a crash test for every durable transition you write: a command that must not apply twice, a failure that must roll back, a timer that must fire once.

## Declared failures

A declared failure rolls back the turn's writes and commits only the failure in the receipt. Test both halves: the caller sees the typed error, and `inspect` shows the state, rows, and events unchanged. The `chat` template's `src/room/layer.test.ts` does this for `RoomClosed`.

## Time, intents, and jobs

Intents, timers, and jobs run after the turn commits. In a test they wait for the test clock:

- `test.advance(duration)` moves the outbox clock forward, then waits until every due intent and job has been delivered, including the intents those deliveries stage, and nothing is still running.
- `test.now` is that clock, for building `Intent.at` times.
- `test.actor(X, id?).system` calls any command, including `internal` ones, as a `System` caller.

Provide the actor's `X.toJobLayer` in the test to run its executors; an executor that fails is retried with backoff, and the retries that fall due within the advanced time run too. `test.inspect(ref)` lists the outbox rows still pending.

## Restarts

State that must survive a restart is tested by building the production wiring twice. The counter template builds its `src/main.ts` layers (`Actors.layer` over `Database.pglite` or `Database.postgres`), sends a command, disposes the runtime, builds it again on the same data, and checks the count went up once per run.

## Choosing the database

`ActorTest.layer({ database })` takes:

- nothing: a fresh in-memory PGlite, the fastest option;
- `{ dataDir }`: file-backed PGlite that persists across builds;
- a `Redacted` URL: Postgres.

PGlite runs every turn through the same SQL as Postgres and is right for handler logic, receipts, rollbacks, and state migrations. It has one connection, so it cannot show lock contention, independent connections, multi-runner behavior, or recovery after a process kill. Test those on Postgres. The framework's own conformance cases that need a second connection report themselves skipped on PGlite rather than passing.

`ActorTest.cluster({ database, runners, ... })` runs several runners in one process against one Postgres database, with `kill`, `restart`, and `pauseHeartbeat` per runner, for tests of ownership moving between runners. It refuses PGlite.

## Further reading

- The `/testing` exports and every option: [server API](../api/01-server-api.md#implemented-foundation-subset).
- What the framework itself proves, per backend: the [support matrix](../operations/support-matrix.md).
