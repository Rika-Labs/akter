import { PGlite } from "@electric-sql/pglite"
import { PgliteClient } from "@effect/sql-pglite"
import { Effect } from "effect"

/** Own fresh instances; borrowed clients retain their original methods and lifetime. */
export const pglite = (config: PgliteClient.PgliteClientConfig = {}) => {
  if ("liveClient" in config) return PgliteClient.layer(config)

  return PgliteClient.layerFrom(
    Effect.gen(function* () {
      const pending = new Set<Promise<unknown>>()

      const database = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const database = new PGlite(config)
          const query = database.query.bind(database)
          // Interrupted SQL fibers can leave protocol exchanges running. Closing
          // PGlite during one deadlocks its single connection; drain after users stop.
          database.query = (...args) => {
            // SAFETY: preserve query's signature; erase only its generic row type for bookkeeping.
            const promise = (query as (...a: typeof args) => Promise<never>)(...args)
            pending.add(promise)

            return promise.finally(() => pending.delete(promise))
          }

          return database
        }),
        (database) =>
          Effect.gen(function* () {
            while (pending.size > 0) yield* Effect.promise(() => Promise.allSettled(pending))
            yield* Effect.promise(() => database.close())
          }),
      )

      yield* Effect.promise(() => database.waitReady)

      return yield* PgliteClient.make({ ...config, liveClient: database })
    }),
  )
}
