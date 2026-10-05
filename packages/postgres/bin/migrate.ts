import { BunFileSystem } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import { Database } from "@rikalabs/akter/runtime"
import { Config, Effect, FileSystem, Function, Layer, Predicate, Redacted } from "effect"
import { SqlClient } from "effect/sql"

const LOCK = 741902113

const token =
  /--[^\n]*|'(?:[^']|'')*'|"(?:[^"]|"")*"|\$([A-Za-z_]*)\$[\s\S]*?\$\1\$|;|[^;'"$-]+|[\s\S]/y

/**
 * A migration file's statements in order, split at semicolons outside quoted
 * text and dollar-quoted bodies, without comments, so each can run on its own.
 */
export const statements = (text: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  let current = ""
  token.lastIndex = 0
  for (let match = token.exec(text); match !== null; match = token.exec(text)) {
    const [part] = match
    if (part.startsWith("--")) continue
    if (part !== ";") {
      current += part
      continue
    }
    if (current.trim() !== "") found.push(current.trim())
    current = ""
  }
  if (current.trim() !== "") found.push(current.trim())
  return found
}

const migrateEffect = Effect.fn("Database.migrate")(function* (startAt?: string) {
  const fs = yield* FileSystem.FileSystem
  const sql = yield* SqlClient.SqlClient
  const directory = new URL("../migrations/", import.meta.url).pathname

  const names = (yield* fs.readDirectory(directory))
    .filter((name) => name.endsWith(".sql") && (startAt === undefined || name >= startAt))
    .sort()

  yield* Database.schemaChange(
    sql`create table if not exists project_migration (name text primary key, applied_at timestamptz not null default now())`,
    LOCK,
  )

  for (const name of names)
    yield* Database.schemaChange(
      Effect.gen(function* () {
        const applied = yield* sql`select 1 from project_migration where name = ${name}`
        if (applied.length !== 0) return
        for (const statement of statements(yield* fs.readFileString(`${directory}${name}`)))
          yield* sql.unsafe(statement)
        yield* sql`insert into project_migration(name) values (${name})`
      }),
      LOCK,
    )
})

interface MigrateOptions {
  readonly startAt?: string
  readonly neki?: boolean
}

const run = (url: string, options: MigrateOptions | undefined) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          Layer.mergeAll(
            PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }),
            Layer.succeed(Database.Neki, options?.neki === true),
            BunFileSystem.layer,
          ),
        )
        yield* migrateEffect(options?.startAt).pipe(Effect.provideContext(context))
      }),
    ).pipe(Effect.orDie),
  )

/**
 * Applies the `.sql` files in `migrations/` that are not yet recorded, in name
 * order, each under advisory lock `741902113` so concurrent callers apply each
 * file once. On Postgres a file and its record share one transaction, and a
 * failing file is rolled back and rejects. With `neki`, each statement
 * autocommits and propagates before the next runs, and a file is recorded
 * only after its last statement, so every statement must be safe to rerun
 * after a crash part way through its file.
 */
export const migrate: {
  (url: string, options?: MigrateOptions): Promise<void>
  (options?: MigrateOptions): (url: string) => Promise<void>
} = Function.dual((args) => Predicate.isString(args[0]), run)

if (import.meta.main)
  void Effect.runPromise(
    Effect.gen(function* () {
      const url = yield* Config.String("DATABASE_URL")
      const engine = yield* Config.Literals(
        ["postgres", "neki"],
        "CONTROL_PLANE_DATABASE_ENGINE",
      ).pipe(Config.withDefault("postgres"))
      yield* Effect.promise(() => run(url, { neki: engine === "neki" }))
      yield* Effect.log("Database migrations complete")
    }),
  )
