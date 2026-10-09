import { BunServices } from "@effect/platform-bun"
import { Config, Console, Effect, ManagedRuntime, Redacted, Schema, Stream } from "effect"
import { Actor } from "../../../../../packages/akter/src/index.ts"
import { ColdStorage } from "../../../../../packages/akter/src/runtime/storage/cold-storage.ts"
import { ColdLedger, openCold } from "../postgres/cold-tier.ts"

const program = Effect.gen(function* () {
  const mode = yield* Config.String("CRASH_MODE")
  const point = yield* Config.String("CRASH_POINT")
  const commandId = yield* Config.String("CRASH_COMMAND_ID")
  const store = yield* ColdStorage.filesystem(yield* Config.String("CRASH_STORE"))
  const stop = Console.log("READY").pipe(Effect.andThen(Effect.never))
  const { context, sql, test, tier } = yield* openCold(
    Redacted.make(yield* Config.String("CRASH_DATABASE_URL")),
    store,
    { periodic: false, at: (at) => (at === point ? stop : Effect.void) },
    { at: (at, request) => (at === point && request.command === "Add" ? stop : Effect.void) },
  )
  const actor = yield* ColdLedger.get("crashed").pipe(
    Actor.tenant("cold-process"),
    Effect.provideContext(context),
  )
  if (mode === "prepare-warm" || mode === "prepare-cold" || mode === "prepare-garbage") {
    yield* actor.Seed()
    yield* test.hibernate(actor.ref)
    if (mode !== "prepare-warm") yield* test.advance(2)
    if (mode === "prepare-garbage") {
      yield* actor.Add(7).pipe(Actor.commandId(commandId))
      yield* sql`UPDATE actor_cold_garbage SET unreferenced_at_ms = 0`
    }
    return
  }
  if (mode === "offload") yield* test.advance("2 minutes")
  else if (mode === "collect") {
    yield* actor.Add(7).pipe(Actor.commandId(commandId))
    yield* tier!.sweep()
  } else if (mode === "turn") yield* actor.Add(7).pipe(Actor.commandId(commandId))
  else {
    if (mode === "recover-collect") {
      yield* actor.Add(7).pipe(Actor.commandId(commandId))
      yield* tier!.sweep()
    } else yield* test.advance("4 minutes")
    const reply = yield* actor.Add(7).pipe(Actor.commandId(commandId))
    const snapshot = yield* actor.Read()
    const [counts] = yield* sql<{
      receipts: number
      state: number
      chunks: number
      events: number
      cold: boolean
      garbage: number
    }>`
      SELECT (SELECT count(*)::int FROM actor_receipts) AS receipts,
        (SELECT count(*)::int FROM actor_state) AS state,
        (SELECT count(*)::int FROM actor_blobs) AS chunks,
        (SELECT count(*)::int FROM actor_events) AS events,
        (SELECT cold_ref IS NOT NULL FROM actor_generations) AS cold,
        (SELECT count(*)::int FROM actor_cold_garbage) AS garbage`
    const objects = (yield* store.list("").pipe(Stream.runCollect)).length
    yield* Console.log(
      `RESULT ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({ reply, snapshot, ...counts, objects })}`,
    )
    return
  }
  return yield* Effect.die(new Error("Cold crash boundary was not reached"))
})

if (import.meta.main) {
  const runtime = ManagedRuntime.make(BunServices.layer)
  await runtime.runPromise(program.pipe(Effect.scoped)).finally(() => runtime.dispose())
}
