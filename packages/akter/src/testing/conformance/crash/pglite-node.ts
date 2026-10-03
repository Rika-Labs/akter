import { Config, Console, Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { DataDirLocked, DataDirVersion } from "../../../errors/database.ts"
import { pglite } from "../../../runtime/database/pglite.ts"

/**
 * One process on a file-backed PGlite `dataDir`, started by `pglite-node.test.ts`
 * under Node. `PGLITE_MODE` picks the step: `write:<value>` commits a row and
 * exits, `hold:<value>` commits a row and stays open until killed (a pending timer keeps Node alive, which `Effect.never` does not), `read`
 * prints every committed row, and `open` only builds the layer. A refused open
 * prints `REFUSED <reason>` and exits.
 */
const program = Effect.gen(function* () {
  const [step, detail = ""] = (yield* Config.String("PGLITE_MODE")).split(":")
  const dataDir = yield* Config.String("PGLITE_DATA_DIR")
  const relaxedDurability = yield* Config.Boolean("PGLITE_RELAXED").pipe(Config.withDefault(false))

  yield* Console.log(`RUNTIME ${process.versions.bun === undefined ? "node" : "bun"}`)

  const context = yield* Layer.build(pglite({ dataDir, relaxedDurability }))
  const sql = Context.get(context, SqlClient.SqlClient)

  if (step === "open")
    return yield* Console.log("OPEN").pipe(Effect.andThen(Effect.forever(Effect.sleep("1 hour"))))

  yield* sql`CREATE TABLE IF NOT EXISTS notes (value text NOT NULL)`

  if (step === "write" || step === "hold") {
    yield* sql`INSERT INTO notes (value) VALUES (${detail})`
    yield* Console.log("WROTE")
    if (step === "hold") return yield* Effect.forever(Effect.sleep("1 hour"))
  }

  const rows = yield* sql<{ value: string }>`SELECT value FROM notes ORDER BY value`
  yield* Console.log(`ROWS ${rows.map((row) => row.value).join(",")}`)
}).pipe(
  Effect.scoped,
  Effect.catchTags({
    DataDirLocked: (error: DataDirLocked) => Console.log(`REFUSED DataDirLocked ${error.dataDir}`),
    DataDirVersion: (error: DataDirVersion) =>
      Console.log(`REFUSED DataDirVersion ${error.found} ${error.expected}`),
  }),
  Effect.catchDefect((defect) => Console.log(`REFUSED Defect ${String(defect)}`)),
)

await Effect.runPromise(program)
