import { Deferred, Effect } from "effect"
import { load } from "../../measure.ts"
import { FamilyRoot, marks, SpreadItem, spreadId } from "../../probe/ledger.ts"
import { type CaseResult, measure, type Scenario } from "../../scenario.ts"

const ITEMS = 10

/** Registers `label` so the item's turn can report it; returns the wait for it. */
const expectMark = (label: string) =>
  Deferred.make<void>().pipe(
    Effect.tap((pending) => Effect.sync(() => marks.set(label, pending))),
    Effect.map((pending) =>
      Deferred.await(pending).pipe(Effect.ensuring(Effect.sync(() => marks.delete(label)))),
    ),
  )

/**
 * Parent placement against actor placement for one family: an order-like
 * root and its items. `intent-<placement>` times a root turn that stages one
 * intent to an item until the item's turn has run; under `{ parent }` the
 * outbox row and the item share the root's shard. `family-read-<placement>`
 * reads all `ITEMS` items' rows: one `group` select from the root under
 * `{ parent }`, and one query per item under `"actor"`, which is what a
 * family read costs when the items live on their own shards.
 */
export const placement: Scenario = {
  name: "placement",
  description:
    "Parent placement against actor placement: parent-to-child intent latency, and reading a 10-item family in one group select against one query per item.",
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const operations = quick ? 200 : 2000
      const results: Array<CaseResult> = []

      for (const parented of [true, false]) {
        const kind = parented ? "parent" : "actor"

        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              const root = yield* FamilyRoot.get(`intent-${kind}`)
              let next = 0

              const notify = () =>
                Effect.gen(function* () {
                  const label = `${kind}-${next++}`
                  const done = yield* expectMark(label)
                  yield* root.Notify({ item: `item-${next % ITEMS}`, parented, label })
                  yield* done
                })

              yield* load({ workers: 1, operations: 20, operation: notify })

              return yield* measure({
                name: `intent-${kind}`,
                parameters: { placement: kind, workers: 1 },
                instruments,
                workers: 1,
                operations,
                operation: notify,
              })
            }),
          ),
        )

        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              const root = yield* FamilyRoot.get(`read-${kind}`)

              for (let item = 0; item < ITEMS; item++) {
                const label = `seed-${kind}-${item}`
                const done = yield* expectMark(label)
                yield* root.Notify({ item: `item-${item}`, parented, label }).pipe(Effect.orDie)
                yield* done
              }

              const items = yield* Effect.forEach(
                Array.from({ length: ITEMS }, (_, item) =>
                  spreadId({ root: root.ref.id, item: `item-${item}` }),
                ),
                (id) => SpreadItem.get(id),
              )

              const read = parented
                ? () => root.FamilyLabels()
                : () =>
                    Effect.forEach(items, (item) => item.ItemLabels()).pipe(
                      Effect.map((counts) => counts.reduce((sum, count) => sum + count, 0)),
                    )

              if ((yield* read().pipe(Effect.orDie)) !== ITEMS)
                return yield* Effect.die(new Error(`${kind} family read missed items`))

              yield* load({ workers: 1, operations: 20, operation: read })

              return yield* measure({
                name: `family-read-${kind}-${ITEMS}`,
                parameters: { placement: kind, items: ITEMS, workers: 1 },
                instruments,
                workers: 1,
                operations,
                operation: read,
              })
            }),
          ),
        )
      }

      return results
    }),
}
