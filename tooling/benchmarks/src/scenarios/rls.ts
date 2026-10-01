import type { ActorError, Actors } from "@rikalabs/akter"
import { Effect } from "effect"
import { load } from "../measure.ts"
import { Probe } from "../probe/contract.ts"
import { Ledger } from "../probe/ledger.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

const SEEDED = 1000

type Operation = (index: number) => Effect.Effect<unknown, ActorError>

/**
 * What row-level security costs: the same warm turns and queries with the
 * runtime connected as the exempt table owner, then as the tenant role.
 */
export const rls: Scenario = {
  name: "rls",
  description:
    "Warm command turns, state queries, and owned-row inserts and point reads on one actor, with row-level security off and then on (Postgres only).",
  run: (context) =>
    Effect.gen(function* () {
      if (context.backend.name !== "postgres") return []

      const operations = context.quick ? 300 : 3000

      const cases: ReadonlyArray<{
        readonly name: string
        readonly operation: Effect.Effect<Operation, never, Actors>
      }> = [
        {
          name: "turn",
          operation: Effect.map(Effect.orDie(Probe.get("hot")), (probe) => () => probe.Add(1)),
        },
        {
          name: "query",
          operation: Effect.map(Effect.orDie(Probe.get("hot")), (probe) => () => probe.Peek()),
        },
        {
          name: "owned-insert",
          operation: Effect.map(
            Effect.orDie(Ledger.get("measured")),
            (ledger) => (index) => ledger.Append(`append-${index}`),
          ),
        },
        {
          name: "owned-read-one",
          operation: Effect.map(
            Effect.orDie(Ledger.get("measured")),
            (ledger) => (index) => ledger.Entry(`seed-${index % SEEDED}`),
          ),
        },
      ]

      const results: Array<CaseResult> = []

      for (const rowLevelSecurity of [false, true])
        for (const entry of cases)
          results.push(
            yield* context.withRuntime({ rowLevelSecurity }, (instruments) =>
              Effect.gen(function* () {
                const ledger = yield* Ledger.get("measured").pipe(Effect.orDie)

                for (let from = 0; from < SEEDED; from += 250)
                  yield* ledger.Seed({ from, count: 250 }).pipe(Effect.orDie)

                const operation = yield* entry.operation.pipe(Effect.orDie)
                yield* load({
                  workers: 1,
                  operations: 100,
                  operation: (index) => operation(-1 - index),
                })

                return yield* measure({
                  name: `${entry.name}-${rowLevelSecurity ? "on" : "off"}`,
                  parameters: { actors: 1, workers: 1, rowLevelSecurity },
                  instruments,
                  workers: 1,
                  operations,
                  operation,
                  listStatements: true,
                })
              }),
            ),
          )

      return results
    }),
}
