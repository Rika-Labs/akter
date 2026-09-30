import { Context, Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { Actor, Content, ContentStore } from "../../index.ts"
import { withoutDatabase } from "./isolation.ts"

it("rejects an executor that requires the SQL client", () => {
  const Lookup = Actor.job("Lookup", { payload: { id: Schema.String } })
  const Owner = Actor.make("DatabaseFree", { jobs: { Lookup: { job: Lookup } } })
  const direct = { Lookup: () => Effect.service(SqlClient.SqlClient).pipe(Effect.asVoid) }

  const built = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return { Lookup: () => sql`SELECT 1`.pipe(Effect.orDie, Effect.asVoid) }
  })

  // @ts-expect-error executors have no database capability
  const layer = Owner.toJobLayer<typeof direct>(direct)
  // @ts-expect-error a SQL client captured while building would reach executors
  const captured = Owner.toJobLayer<Effect.Success<typeof built>, never, SqlClient.SqlClient>(built)

  expect([layer, captured]).toHaveLength(2)
})

it("gives executors no content access, by type and at run time", () => {
  const Archive = Actor.job("Archive", { payload: { id: Schema.String } })
  const Owner = Actor.make("ContentFree", { jobs: { Archive: { job: Archive } } })
  const direct = {
    Archive: () => Content.upload(new Uint8Array()).pipe(Effect.orDie, Effect.asVoid),
  }
  // @ts-expect-error executors have no content capability
  const layer = Owner.toJobLayer<typeof direct>(direct)

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
