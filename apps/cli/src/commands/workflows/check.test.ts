import { Actor, User } from "@durable-actors/core"
import { ActorTest } from "@durable-actors/core/testing"
import { BunCrypto } from "@effect/platform-bun"
import { Effect, Layer, Schedule, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { describe, expect, it } from "vitest"

import { UsageError, actorsOf, check, loadEntry, parseCheck } from "./check.ts"

const deployment = (label: string | null) => {
  const Order = Actor.workflow("Order", {
    input: { id: Schema.String },
    output: Schema.String,
    key: ({ id }) => id,
  })

  const Pause = Order.sleep("pause")

  const Label =
    label === null ? undefined : Order.step(label, { input: Schema.String, success: Schema.String })

  const Shop = Actor.make("Shop", { key: Schema.String, api: { Order } })

  const layer = Shop.toLayer(
    Effect.succeed({
      Order: Effect.fnUntraced(function* (input: { readonly id: string }) {
        yield* Pause("1 minute")

        return Label === undefined ? input.id : yield* Label.run(input.id, Effect.succeed)
      }),
    }),
  )

  return { Shop, layer }
}

const Current = deployment("label")

const Removed = deployment(null)

const live = Current.layer.pipe(
  Layer.provideMerge(ActorTest.layer({ as: User.make({ subject: "alice" }) })),
  Layer.provideMerge(BunCrypto.layer),
)

const sleeping = Effect.gen(function* () {
  const shop = yield* Current.Shop.get("s")
  const started = yield* shop.Order({ id: "o" })
  const sql = yield* SqlClient.SqlClient

  yield* sql<{ status: string }>`SELECT status FROM actor_workflow_executions
    WHERE execution_id = ${started.executionId}`.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("25 millis"),
      until: (rows) => rows[0]?.status === "suspended",
    }),
    Effect.orDie,
  )
})

describe("durable workflows check", () => {
  it("durable workflows check exits 1 with the blocking groups and 0 when compatible", () =>
    Effect.gen(function* () {
      yield* sleeping

      const compatible = yield* check({ actors: [Current.Shop], json: false })
      expect(compatible.exitCode).toBe(0)

      const refused = yield* check({ actors: [Removed.Shop], json: false })
      expect(refused.exitCode).toBe(1)
      const lines = refused.output.split("\n")
      expect(lines[0]).toMatch(/^Shop\/Order {2}step "label" removed {2}1 open execution \(oldest /)
      expect(lines[1]).toBe("1 incompatibility; deploy refused (exit 1)")

      const json = yield* check({ actors: [Removed.Shop], json: true })
      expect(json.exitCode).toBe(1)
      expect(json.output).toContain(`"compatible": false`)
      expect(json.output).toContain(`"problem": "step \\"label\\" removed"`)

      const gone = yield* check({ actors: [], json: true })
      expect(gone.incompatibilities.map(({ problem }) => problem)).toEqual(["actor type removed"])
    }).pipe(
      (body) =>
        Layer.build(live).pipe(Effect.flatMap((context) => Effect.provideContext(body, context))),
      Effect.scoped,
      Effect.runPromise,
    ))

  it("parses its arguments and rejects a missing entry module or one without an actors array", () =>
    Effect.gen(function* () {
      expect(
        yield* parseCheck(["--entry", "./a.ts", "--database-url", "postgres://x", "--json"]),
      ).toEqual({ entry: "./a.ts", databaseUrl: "postgres://x", json: true })

      for (const [failure, message] of [
        [yield* Effect.flip(parseCheck(["--entry", "./a.ts"])), "--database-url is required"],
        [yield* Effect.flip(parseCheck(["--verbose"])), "Unknown argument: --verbose"],
        [
          yield* Effect.flip(actorsOf({ module: { Shop: Current.Shop }, entry: "./a.ts" })),
          "./a.ts must export an `actors` array of actor definitions",
        ],
        [
          yield* Effect.flip(
            actorsOf({
              module: { actors: [{ name: "Shop", api: { Order: { kind: "workflow" } } }] },
              entry: "./a.ts",
            }),
          ),
          "./a.ts: Shop.Order is not an Actor.workflow definition",
        ],
      ] as const) {
        expect(failure).toBeInstanceOf(UsageError)
        expect(failure.message).toBe(message)
      }

      const absent = yield* Effect.flip(loadEntry("./does-not-exist.ts"))
      expect(absent).toBeInstanceOf(UsageError)
      expect(absent.message).toMatch(/^Cannot load \.\/does-not-exist\.ts: /)

      const [loaded] = yield* actorsOf({ module: { actors: [Current.Shop] }, entry: "./a.ts" })
      expect(loaded?.name).toBe("Shop")
      expect(loaded?.api["Order"]).toBe(Current.Shop.api.Order)
    }).pipe(Effect.runPromise))
})
