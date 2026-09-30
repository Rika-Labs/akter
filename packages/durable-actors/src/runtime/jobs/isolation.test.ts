import { Context, Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { Actor, Content, ContentStore } from "../../index.ts"
import { withoutDatabase } from "./isolation.ts"

it("rejects an executor that requires the SQL client", () => {
  class Lookup extends Actor.effect<Lookup>()("Lookup", { input: { id: Schema.String } }) {}

  const Owner = Actor.make("DatabaseFree", { effects: [Lookup], api: {} })

  const layer = Owner.toEffectLayer(
    // @ts-expect-error executors have no database capability
    Effect.succeed({
      Lookup: () => Effect.service(SqlClient.SqlClient).pipe(Effect.asVoid),
    }),
  )

  const captured = Owner.toEffectLayer(
    // @ts-expect-error a SQL client captured while building would reach executors
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      return { Lookup: () => sql`SELECT 1`.pipe(Effect.orDie, Effect.asVoid) }
    }),
  )

  expect([layer, captured]).toHaveLength(2)
})

it("gives executors no content access, by type and at run time", () => {
  class Archive extends Actor.effect<Archive>()("Archive", { input: { id: Schema.String } }) {}

  const Owner = Actor.make("ContentFree", { effects: [Archive], api: {} })

  const layer = Owner.toEffectLayer(
    // @ts-expect-error executors have no content capability
    Effect.succeed({
      Archive: () => Content.upload(new Uint8Array()).pipe(Effect.orDie, Effect.asVoid),
    }),
  )

  const store = ContentStore.of({
    uploadBytes: () => Effect.die(new Error("unreachable")),
    upload: () => Effect.die(new Error("unreachable")),
    grant: () => Effect.die(new Error("unreachable")),
    download: () => Effect.die(new Error("unreachable")),
  })

  const seen = Effect.runSync(
    Effect.serviceOption(ContentStore).pipe(
      withoutDatabase(Context.make(ContentStore, store) as Context.Context<never>),
    ),
  )

  expect([layer, Option.isNone(seen)]).toEqual([layer, true])
})
