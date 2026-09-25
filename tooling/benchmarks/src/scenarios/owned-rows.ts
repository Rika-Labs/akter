import type { ActorError } from "durable-actors"
import { Effect } from "effect"
import { load } from "../measure.ts"
import { Ledger } from "../probe/ledger.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

const SEEDED = 1000

const NEIGHBORS = 10

/**
 * Owned-table turns and reads on one warm actor whose tenant also holds
 * `NEIGHBORS` other actors with the same business keys, so every scoped
 * statement has other actors' rows to skip.
 */
export const ownedRows: Scenario = {
  name: "owned-rows",
  description:
    "turn.rows insert and read-then-update turns, and read.rows point and page queries, on one actor among 10 neighbours with 1,000 rows each.",
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const operations = quick ? 300 : 3000

      const seeded = <A, E, R>(body: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          for (let actor = 0; actor <= NEIGHBORS; actor += 1) {
            const ledger = yield* Ledger.get(actor === 0 ? "measured" : `neighbor-${actor}`)

            for (let from = 0; from < SEEDED; from += 250)
              yield* ledger.Seed({ from, count: 250 }).pipe(Effect.orDie)
          }

          return yield* body
        })

      const cases: ReadonlyArray<{
        readonly name: string
        readonly operation: (
          ledger: Effect.Success<ReturnType<typeof Ledger.get>>,
        ) => (index: number) => Effect.Effect<unknown, ActorError>
      }> = [
        { name: "insert", operation: (ledger) => (index) => ledger.Append(`append-${index}`) },
        {
          name: "read-update",
          operation: (ledger) => (index) => ledger.Bump(`seed-${index % SEEDED}`),
        },
        {
          name: "read-one",
          operation: (ledger) => (index) => ledger.Entry(`seed-${index % SEEDED}`),
        },
        { name: "read-page-20", operation: (ledger) => () => ledger.Page(20) },
      ]

      const results: Array<CaseResult> = []

      for (const entry of cases)
        results.push(
          yield* context.withRuntime({}, (instruments) =>
            seeded(
              Effect.gen(function* () {
                const ledger = yield* Ledger.get("measured")
                const operation = entry.operation(ledger)
                yield* load({
                  workers: 1,
                  operations: 100,
                  operation: (index) => operation(operations + index),
                })

                return yield* measure({
                  name: entry.name,
                  parameters: { actors: 1, neighbors: NEIGHBORS, rowsPerActor: SEEDED, workers: 1 },
                  instruments,
                  workers: 1,
                  operations,
                  operation,
                  listStatements: true,
                })
              }),
            ),
          ),
        )

      return results
    }),
}
