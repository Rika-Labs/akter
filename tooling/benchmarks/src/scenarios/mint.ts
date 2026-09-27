import { DateTime, Deferred, Effect, Schedule } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { load } from "../measure.ts"
import { Sender } from "../probe/contract.ts"
import { creations, MintedChild, Minter } from "../probe/mint.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

const COUNTS = [0, 1, 10, 100]

/** Room for every child the creation cases activate, so none waits on `RunnerAtCapacity`. */
const RESIDENT = 100_000

/** Registers `labels` so the children's creating turns can report them; returns the wait for all. */
const expectCreations = (labels: ReadonlyArray<string>) =>
  Effect.forEach(labels, (label) =>
    Deferred.make<void>().pipe(
      Effect.tap((created) => Effect.sync(() => creations.set(label, created))),
    ),
  ).pipe(
    Effect.map((pending) =>
      Effect.forEach(pending, Deferred.await, { discard: true }).pipe(
        Effect.ensuring(Effect.sync(() => labels.forEach((label) => creations.delete(label)))),
      ),
    ),
  )

/** Waits until every id's creating turn has committed its creation marker. */
const committed = (ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (ids.length === 0) return

    const sql = yield* SqlClient.SqlClient

    const count = sql<{ readonly created: number }>`
      SELECT count(*)::int AS created FROM actor_generations
      WHERE actor_type = 'MintedChild' AND created AND actor_id IN ${sql.in(ids)}`.pipe(
      Effect.map(([row]) => row!.created),
      Effect.orDie,
    )

    yield* count.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 millis"),
        until: (created) => created === ids.length,
      }),
    )
  })

const labelsOf = (label: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${label}-${index}`)

/**
 * `turn.mint`: a parent turn that mints n children and stages each one's
 * creating intent. `turn-<n>` times only the parent turn, with the intents
 * due in a day; `intents-<n>` is the same turn staging plain intents without
 * minting, so the difference is the derivation and proof cost. `created-<n>`
 * times from the parent's call until every child's creation marker committed,
 * and `create-then-open-<n>` is the same outcome through `X.create()` and one
 * creating command per child from the caller.
 */
export const mint: Scenario = {
  name: "mint",
  description:
    "turn.mint: parent turn cost at 0, 1, 10, and 100 minted children against plain intents, and time until every child exists against X.create() plus one command per child.",
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const results: Array<CaseResult> = []
      const dueAt = DateTime.toEpochMillis(yield* DateTime.now) + 86_400_000

      const operations = (count: number) =>
        Math.max(20, Math.round((quick ? 10_000 : 100_000) / (count + 49)))

      for (const count of COUNTS) {
        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              const parent = yield* Minter.get(`turn-${count}`)
              let next = 0
              const turn = () => parent.MintMany({ label: `turn-${next++}`, count, atMs: dueAt })
              yield* load({ workers: 1, operations: 10, operation: turn })

              return yield* measure({
                name: `turn-${count}`,
                parameters: { children: count, workers: 1 },
                instruments,
                workers: 1,
                operations: operations(count),
                operation: turn,
                listStatements: true,
              })
            }),
          ),
        )

        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              const sender = yield* Sender.get(`intents-${count}`)
              let next = 0

              const turn = () => {
                const offset = next
                next += count

                return sender.SendMany({ offset, count, atMs: dueAt })
              }

              yield* load({ workers: 1, operations: 10, operation: turn })

              return yield* measure({
                name: `intents-${count}`,
                parameters: { children: count, workers: 1 },
                instruments,
                workers: 1,
                operations: operations(count),
                operation: turn,
              })
            }),
          ),
        )

        results.push(
          yield* context.withRuntime({ maxResidentActors: RESIDENT }, (instruments) =>
            Effect.gen(function* () {
              const parent = yield* Minter.get(`created-${count}`)
              let next = 0

              const created = () =>
                Effect.gen(function* () {
                  const label = `created-${next++}`
                  const all = yield* expectCreations(labelsOf(label, count))
                  const ids = yield* parent.MintMany({ label, count })
                  yield* all
                  yield* committed(ids)
                })

              yield* load({ workers: 1, operations: 5, operation: created })

              return yield* measure({
                name: `created-${count}`,
                parameters: { children: count, workers: 1 },
                instruments,
                workers: 1,
                operations: Math.max(10, Math.round(operations(count) / 4)),
                operation: created,
              })
            }),
          ),
        )

        results.push(
          yield* context.withRuntime({ maxResidentActors: RESIDENT }, (instruments) =>
            Effect.gen(function* () {
              const direct = () =>
                Effect.forEach(
                  Array.from({ length: count }),
                  () =>
                    Effect.gen(function* () {
                      const child = yield* MintedChild.create()
                      yield* child.Open("direct")
                    }),
                  { discard: true },
                )

              yield* load({ workers: 1, operations: 5, operation: direct })

              return yield* measure({
                name: `create-then-open-${count}`,
                parameters: { children: count, workers: 1 },
                instruments,
                workers: 1,
                operations: Math.max(10, Math.round(operations(count) / 4)),
                operation: direct,
              })
            }),
          ),
        )
      }

      return results
    }),
}
