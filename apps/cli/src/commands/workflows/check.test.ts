import { Actor, User } from "@durable-actors/core"
import { ActorTest } from "@durable-actors/core/testing"
import { BunCrypto, BunFileSystem } from "@effect/platform-bun"
import { Cause, Context, Effect, Exit, FileSystem, Layer, Schedule, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { describe, expect, it } from "vitest"

import { UsageError } from "../../failure.ts"
import { runCli } from "../../testing.ts"
import { actorsOf, check, loadEntry } from "./check.ts"

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
      const fs = Context.get(yield* Layer.build(BunFileSystem.layer), FileSystem.FileSystem)
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "durable-check-" })
      const entry = `${directory}/entry.ts`
      yield* fs.writeFileString(entry, "export const actors = []\n")

      const unreachable = yield* runCli([
        "workflows",
        "check",
        "--entry",
        entry,
        "--database-url",
        "postgres://127.0.0.1:1/none",
        "--json",
      ])

      expect(unreachable.exitCode).toBe(2)
      expect(unreachable.stderr).toContain("Cannot read workflow state")

      const missing = yield* runCli(["workflows", "check", "--entry", entry])
      expect(missing.exitCode).toBe(2)
      expect(missing.stderr).toContain("Missing required flag: --database-url")

      const unknown = yield* runCli(["workflows", "check", "--verbose"])
      expect(unknown.exitCode).toBe(2)
      expect(unknown.stderr).toContain("Unrecognized flag: --verbose")

      const nowhere = yield* runCli([
        "workflows",
        "check",
        "--entry",
        "./does-not-exist.ts",
        "--database-url",
        "postgres://x",
      ])

      expect(nowhere.exitCode).toBe(2)
      expect(nowhere.stderr).toContain("Path does not exist")

      const broken = `${directory}/broken.ts`
      yield* fs.writeFileString(broken, "export const actors = [\n")

      const unloadable = yield* runCli([
        "workflows",
        "check",
        "--entry",
        broken,
        "--database-url",
        "postgres://x",
      ])

      expect(unloadable.exitCode).toBe(2)
      expect(unloadable.stderr).toContain(`Cannot load ${broken}`)

      const absent = yield* Effect.exit(loadEntry("./does-not-exist.ts"))
      expect(Exit.isFailure(absent) && Schema.is(UsageError)(Cause.squash(absent.cause))).toBe(true)
      expect(Exit.isFailure(absent) && String(absent.cause)).toContain(
        "Cannot load ./does-not-exist.ts",
      )

      const bare = yield* Effect.exit(actorsOf({ module: { Shop: Current.Shop }, entry: "./a.ts" }))
      expect(Exit.isFailure(bare) && String(bare.cause)).toContain("must export an `actors` array")

      const fake = yield* Effect.exit(
        actorsOf({
          module: { actors: [{ name: "Shop", api: { Order: { kind: "workflow" } } }] },
          entry: "./a.ts",
        }),
      )

      expect(Exit.isFailure(fake) && Schema.is(UsageError)(Cause.squash(fake.cause))).toBe(true)
      expect(Exit.isFailure(fake) && String(fake.cause)).toContain(
        "Shop.Order is not an Actor.workflow definition",
      )

      const [loaded] = yield* actorsOf({ module: { actors: [Current.Shop] }, entry: "./a.ts" })
      expect(loaded?.name).toBe("Shop")
      expect(loaded?.api["Order"]).toBe(Current.Shop.api.Order)
    }).pipe(Effect.scoped, Effect.runPromise))
})
