import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Deferred, Duration, Effect, Layer, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Actor } from "../../../../index.ts"
import { Actors, Database } from "../../../../runtime/index.ts"
import { TurnGroupSettings } from "../../../../runtime/turn/group.ts"
import { TurnHooks } from "../../../../runtime/turn/hooks.ts"

const Add = Actor.command("Add", { payload: Schema.Finite, success: Schema.Finite })

const Counter = Actor.make("GroupCrashCounter", {
  key: Schema.String,
  state: Actor.state({ count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Add },
})

const CounterLive = Counter.toLayer(
  Effect.succeed({
    Add: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* Counter.Turn
      yield* turn.state.set({ count: turn.state.count + amount })

      return turn.state.count
    }),
  }),
)

/**
 * In `crash` mode every listed command waits before its handler until all of
 * them arrived, so they share one group. Every member but the last then
 * hands over its writes; the last waits for them, prints READY, and never
 * hands over, so the group holds its members' writes unsent while the
 * parent kills the process. In `commit` mode every member hands over, and a
 * deferred trigger makes the group's `COMMIT` wait on an advisory lock the
 * parent holds, so the parent kills the process with the `COMMIT` sent.
 */
const live = Layer.unwrap(
  Effect.gen(function* () {
    const mode = yield* Config.String("CRASH_MODE")
    const ids = (yield* Config.String("CRASH_COMMAND_IDS")).split(",")
    const database = yield* Config.String("CRASH_DATABASE_URL")
    const arrived = Deferred.makeUnsafe<void>()
    const handed = Deferred.makeUnsafe<void>()
    let arrivals = 0
    let handing = 0

    const at = (point: string, commandId: string) => {
      const index = ids.indexOf(commandId)

      if (mode === "recover" || index === -1) return Effect.void

      if (point === "beforeHandler")
        return Effect.suspend(() => {
          arrivals += 1

          if (arrivals === ids.length) Deferred.doneUnsafe(arrived, Effect.void)

          return Deferred.await(arrived)
        })

      if (point !== "beforeCommit" || mode !== "crash") return Effect.void

      if (index < ids.length - 1)
        return Effect.sync(() => {
          handing += 1

          if (handing === ids.length - 1) Deferred.doneUnsafe(handed, Effect.void)
        })

      return Deferred.await(handed).pipe(
        Effect.andThen(Effect.sleep("500 millis")),
        Effect.andThen(Console.log("READY")),
        Effect.andThen(Effect.never),
      )
    }

    return CounterLive.pipe(
      Layer.provideMerge(
        Actors.layer().pipe(
          Layer.provide(
            Layer.succeed(TurnHooks, { at: (point, request) => at(point, request.commandId) }),
          ),
        ),
      ),
      Layer.provideMerge(Database.postgres({ url: Redacted.make(database) })),
      Layer.provide(Layer.succeed(TurnGroupSettings, { wait: Duration.minutes(1) })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer))

const program = Effect.gen(function* () {
  const mode = yield* Config.String("CRASH_MODE")
  const ids = (yield* Config.String("CRASH_COMMAND_IDS")).split(",")
  const counters = yield* Effect.forEach(ids, (_, index) => Counter.get(`member-${index}`))

  if (mode !== "recover") {
    for (const counter of counters) yield* counter.Add(1)

    if (mode === "commit") {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`CREATE FUNCTION hold_group_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(4950); RETURN NULL; END $$`)
      yield* sql.unsafe(`CREATE CONSTRAINT TRIGGER hold_group_commit AFTER INSERT ON actor_receipts
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        WHEN (NEW.command_id IN (${ids.map((id) => `'${id}'`).join(", ")}))
        EXECUTE FUNCTION hold_group_commit()`)
    }

    yield* Effect.forEach(
      counters,
      (counter, index) => counter.Add(10).pipe(Actor.commandId(ids[index]!)),
      { concurrency: "unbounded" },
    )

    return yield* Effect.die(new Error("The group committed before the crash"))
  }

  const values = yield* Effect.forEach(
    counters,
    (counter, index) => counter.Add(10).pipe(Actor.commandId(ids[index]!)),
    { concurrency: "unbounded" },
  )

  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.Finite)))(
    values,
  )

  yield* Console.log(`RESULT ${encoded}`)
}).pipe(Effect.timeout("20 seconds"))

Layer.effectDiscard(program).pipe(
  Layer.provide(live),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
