import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Redacted, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor } from "../../../index.ts"
import { ActorError } from "../../../errors/actor.ts"
import { Actors as ActorIds } from "../../../handles/actors.ts"
import { InternalActors } from "../../../runtime/actors.ts"
import { Actors, Database } from "../../../runtime/index.ts"
import { decompress } from "../../../runtime/storage/codec.ts"
import { FrameworkClock } from "../../../runtime/turn/admission.ts"
import { CleanupHooks } from "../../../runtime/turn/hooks.ts"

class Logged extends Actor.Event<Logged>()("Logged", { n: Schema.Int }) {}

const Add = Actor.command("Add", { input: Schema.Int })

const Log = Actor.command("Log", { input: Schema.Int })

const Ledger = Actor.make("CrashLedger", {
  key: Schema.String,
  state: Actor.state({ total: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  events: [Logged],
  api: { Add, Log },
  policy: { keepReceipts: "1 day", keepEvents: "1 day" },
})

const live = Ledger.toLayer(
  Effect.succeed({
    Add: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* Ledger.Turn
      yield* turn.state.set({ total: turn.state.total + amount })
    }),
    Log: Effect.fnUntraced(function* (count: number) {
      const turn = yield* Ledger.Turn

      for (let n = 1; n <= count; n++) yield* turn.emit(Logged.make({ n }))
    }),
  }),
)

/** The crashing process stops inside its sweep, after this many committed batches. */
const CRASH_AFTER_BATCHES = 5

const DAY = 86_400_000

let offset = 0

const runtime = Layer.unwrap(
  Effect.gen(function* () {
    const mode = yield* Config.String("CRASH_POINT")
    const database = yield* Config.String("CRASH_DATABASE_URL")
    let batches = 0

    const hooks = Layer.mergeAll(
      Layer.succeed(FrameworkClock, { offsetMillis: () => offset }),
      Layer.succeed(CleanupHooks, {
        batchSize: mode === "crash" ? 2 : 1000,
        afterBatch: Effect.suspend(() =>
          mode === "crash" && ++batches === CRASH_AFTER_BATCHES
            ? Console.log("READY").pipe(Effect.andThen(Effect.never))
            : Effect.void,
        ),
        periodic: false,
      }),
    )

    return live.pipe(
      Layer.provideMerge(Actors.layer().pipe(Layer.provide(hooks))),
      Layer.provideMerge(Database.postgres({ url: Redacted.make(database) })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer))

const Result = Schema.fromJsonString(
  Schema.Struct({
    sequence: Schema.String,
    events: Schema.Array(Schema.String),
    retry: Schema.String,
    total: Schema.String,
  }),
)

const program = Effect.gen(function* () {
  const mode = yield* Config.String("CRASH_POINT")
  const sql = yield* SqlClient.SqlClient
  const internal = yield* InternalActors
  const ledger = yield* Ledger.get("ledger")

  if (mode === "crash") {
    const id = yield* (yield* ActorIds).mintCommandId
    yield* ledger.Add(1).pipe(Actor.commandId(id))

    for (let n = 2; n <= 6; n++) yield* ledger.Add(n)
    yield* ledger.Log(12)
    yield* Console.log(`ID ${id}`)
    offset = 40 * DAY
    yield* internal.cleanup

    return yield* Effect.die(new Error("the sweep finished before its crash point"))
  }

  offset = 40 * DAY
  yield* internal.cleanup
  yield* ledger.Log(1)

  const retry = yield* ledger.Add(1).pipe(
    Actor.commandId(yield* Config.String("CRASH_COMMAND_ID")),
    Effect.as("ran"),
    Effect.catchIf(Schema.is(ActorError), (error) => Effect.succeed(error.reason._tag)),
  )

  const [row] = yield* sql<{ sequence: string; events: ReadonlyArray<string> | null }>`
    SELECT g.event_sequence::text AS sequence,
      (SELECT array_agg(e.sequence::text ORDER BY e.sequence) FROM actor_events e
       WHERE e.actor_id = g.actor_id) AS events
    FROM actor_generations g WHERE g.actor_type = 'CrashLedger'`

  const [state] = yield* sql<{ value: Uint8Array }>`
    SELECT value FROM actor_state WHERE actor_type = 'CrashLedger' AND key = 'total'`

  const result = yield* Schema.encodeEffect(Result)({
    sequence: row!.sequence,
    events: row!.events ?? [],
    retry,
    total: decompress(state!.value),
  })

  yield* Console.log(`RESULT ${result}`)
}).pipe(Effect.timeout("15 seconds"))

Layer.effectDiscard(program).pipe(
  Layer.provide(runtime),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
