import { Actor, User } from "@durable-actors/core"
import { ActorTest } from "@durable-actors/core/testing"
import { BunCrypto, BunFileSystem } from "@effect/platform-bun"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import {
  Clock,
  Config,
  Context,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Schema,
} from "effect"
import { SqlClient } from "effect/sql"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { runCli } from "../../testing.ts"
import { adopt, parseWindow, type AdoptOptions } from "./run.ts"

const invoices = pgTable("cli_invoices", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  accountId: text("account_id").notNull(),
  amount: integer("amount").notNull().default(0),
})

const Invoicing = Actor.make("Invoicing", {
  key: Schema.String,
  tables: [Actor.table(invoices, { owner: { tenant: invoices.orgId, actor: invoices.accountId } })],
  api: { Touch: Actor.command("Touch") },
})

const actors = [Invoicing]

const options = (
  command: AdoptOptions["command"],
  rest: Partial<AdoptOptions> = {},
): AdoptOptions => ({
  command,
  entry: "entry.ts",
  databaseUrl: Redacted.make("postgres://unused"),
  table: undefined,
  json: false,
  report: false,
  clear: false,
  sinceMs: undefined,
  batch: undefined,
  writerRole: undefined,
  allow: [],
  quietMs: undefined,
  ...rest,
})

const runtime = ManagedRuntime.make(BunCrypto.layer)

afterAll(() => runtime.dispose())

const postgres = runtime.runSync(Config.String("CLI_BACKEND")) === "postgres"

describe("durable adopt arguments", () => {
  it("reads a table, the window, and every flag of each command", () =>
    Effect.gen(function* () {
      const fs = Context.get(yield* Layer.build(BunFileSystem.layer), FileSystem.FileSystem)
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "durable-adopt-" })
      const entry = `${directory}/e.ts`

      yield* fs.writeFileString(entry, "export const actors = []\n")

      const database = ["--database-url", "postgres://127.0.0.1:1/none"]

      for (const args of [
        ["plan", "--table", "invoices", "--entry", entry, ...database, "--json"],
        [
          "observe",
          "invoices",
          "--report",
          "--since",
          "7d",
          "--clear",
          "--entry",
          entry,
          ...database,
        ],
        ["backfill", "invoices", "--batch", "50", "--entry", entry, ...database],
        [
          "enforce",
          "invoices",
          "--writer-role",
          "durable_writer",
          "--allow",
          "batch_import",
          "--allow",
          "reports",
          "--quiet",
          "1d",
          "--entry",
          entry,
          ...database,
        ],
        ["release", "invoices", "--to", "observe", "--entry", entry, ...database],
        ["status", ...database],
      ]) {
        const unreachable = yield* runCli(["adopt", ...args])

        expect(unreachable).toMatchObject({ exitCode: 2, reason: "SqlError" })
        expect(unreachable.stderr).toContain("Cannot read adoption state")
      }

      expect(parseWindow("12h")).toEqual(Option.some(43_200_000))
      expect(parseWindow("7d")).toEqual(Option.some(7 * 86_400_000))
      expect(parseWindow("week")).toEqual(Option.none())
    }).pipe(Effect.scoped, Effect.runPromise))

  it("refuses an unknown command, a missing flag, a flag on the wrong command, and a bad window or batch", () =>
    Effect.gen(function* () {
      const fs = Context.get(yield* Layer.build(BunFileSystem.layer), FileSystem.FileSystem)
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "durable-adopt-" })
      const entry = `${directory}/e.ts`

      yield* fs.writeFileString(entry, "export const actors = []\n")

      const base = ["--entry", entry, "--database-url", "u"]

      for (const [args, reason, message] of [
        [["migrate", ...base], "UnknownSubcommand", 'Unknown subcommand "migrate"'],
        [["plan", "--entry", entry], "MissingOption", "Missing required flag: --database-url"],
        [["plan", "--database-url", "u"], "MissingOption", "Missing required flag: --entry"],
        [["observe", ...base], "MissingArgument", "Missing required argument: table"],
        [["backfill", ...base], "MissingArgument", "Missing required argument: table"],
        [["plan", "--report", ...base], "UnrecognizedOption", "Unrecognized flag: --report"],
        [
          ["observe", "t", "--since", "7d", ...base],
          "UsageError",
          "--since and --clear belong to observe --report",
        ],
        [["plan", "--batch", "5", ...base], "UnrecognizedOption", "Unrecognized flag: --batch"],
        [
          ["backfill", "t", "--batch", "0", ...base],
          "InvalidValue",
          'Invalid value for flag --batch: "0"',
        ],
        [
          ["observe", "t", "--report", "--since", "week", ...base],
          "InvalidValue",
          'Invalid value for flag --since: "week"',
        ],
        [["plan", "--force", ...base], "UnrecognizedOption", "Unrecognized flag: --force"],
        [["enforce", "t", ...base], "MissingOption", "Missing required flag: --writer-role"],
        [
          ["observe", "t", "--writer-role", "w", ...base],
          "UnrecognizedOption",
          "Unrecognized flag: --writer-role",
        ],
        [
          ["enforce", "t", "--writer-role", "w", "--quiet", "soon", ...base],
          "InvalidValue",
          'Invalid value for flag --quiet: "soon"',
        ],
        [["release", "t", ...base], "MissingOption", "Missing required flag: --to"],
        [
          ["release", "t", "--to", "enforce", ...base],
          "InvalidValue",
          'Invalid value for flag --to: "enforce"',
        ],
        [["plan", "--to", "observe", ...base], "UnrecognizedOption", "Unrecognized flag: --to"],
        [
          ["release", ...base, "--to", "observe"],
          "MissingArgument",
          "Missing required argument: table",
        ],
      ] as const) {
        const refused = yield* runCli(["adopt", ...args])

        expect(refused).toMatchObject({ exitCode: 2, reason })
        expect(refused.stderr).toContain(message)
      }
    }).pipe(Effect.scoped, Effect.runPromise))
})

const provisioned = Effect.gen(function* () {
  const backend = yield* Config.String("CLI_BACKEND")

  const as = User.make({ subject: "alice" })

  if (backend !== "postgres") return { layer: ActorTest.layer({ as }), url: undefined }

  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `adopt_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: base.href })),
    (pool) => Effect.promise(() => pool.end()),
  )

  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
    () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
  )
  base.pathname = `/${name}`

  return { layer: ActorTest.layer({ database: Redacted.make(base.href), as }), url: base.href }
})

describe(`durable adopt against ${postgres ? "Postgres" : "PGlite"}`, () => {
  it("plans, observes, reports legacy writers, backfills, and reports status; each refusal exits 1", () =>
    Effect.gen(function* () {
      const database = yield* provisioned
      const services = yield* Layer.build(database.layer)

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const nowMs = yield* Clock.currentTimeMillis

        yield* sql`CREATE TABLE cli_invoices (id text PRIMARY KEY, org_id text NOT NULL,
          account_id text NOT NULL, amount integer NOT NULL DEFAULT 0)`
        yield* sql`INSERT INTO cli_invoices (id, org_id, account_id) VALUES
          ('i1', 'acme', 'a1'), ('i2', 'acme', 'a2'), ('i3', 'globex', 'a1')`

        const plan = yield* adopt({ options: options("plan"), actors })

        expect(plan.exitCode).toBe(0)
        expect(plan.output).toContain("public.cli_invoices (Invoicing, writable)")
        expect(plan.output).toContain(
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS "cli_invoices_durable_owner" ON "public"."cli_invoices" ("routing_key", "org_id", "account_id");`,
        )
        expect(plan.output).toContain(
          `ALTER TABLE "public"."cli_invoices" ADD COLUMN IF NOT EXISTS routing_key bigint;`,
        )

        const early = yield* adopt({
          options: options("backfill", { table: "cli_invoices" }),
          actors,
        })

        expect(early).toEqual({
          output:
            "public.cli_invoices is not observed; run durable adopt observe cli_invoices first",
          exitCode: 1,
        })

        const unforced = yield* adopt({
          options: options("release", { table: "cli_invoices" }),
          actors,
        })

        expect(unforced).toEqual({
          output: "public.cli_invoices is not enforced",
          exitCode: 1,
        })

        const unknown = yield* adopt({ options: options("observe", { table: "missing" }), actors })

        expect(unknown).toEqual({
          output: "No actor type adopts a table named missing",
          exitCode: 1,
        })

        const observed = yield* adopt({
          options: options("observe", { table: "cli_invoices" }),
          actors,
        })

        expect(observed).toEqual({
          output: "public.cli_invoices is observing",
          exitCode: 0,
        })

        yield* sql`UPDATE cli_invoices SET amount = 5 WHERE org_id = 'acme'`
        yield* sql`DELETE FROM cli_invoices WHERE id = 'i3'`

        const report = yield* adopt({
          options: options("observe", {
            table: "cli_invoices",
            report: true,
            sinceMs: nowMs - 60_000,
          }),
          actors,
        })

        expect(
          report.output.split("\n").map((line) => line.split("  ").slice(0, 3).join("|")),
        ).toEqual([
          expect.stringMatching(/^public\.cli_invoices\|legacy\|/),
          expect.stringMatching(/^public\.cli_invoices\|legacy\|/),
        ])
        expect(report.output).toContain("DELETE")
        expect(report.output).toContain("UPDATE")
        expect(report.output).toContain("2 rows")

        const premature = yield* adopt({
          options: options("enforce", {
            table: "cli_invoices",
            writerRole: "durable_writer",
            quietMs: 86_400_000,
          }),
          actors,
        })

        expect(premature.exitCode).toBe(1)
        expect(premature.output).toContain("public.cli_invoices cannot be enforced:")
        expect(premature.output).toContain("2 rows of public.cli_invoices have no routing_key")
        expect(premature.output).toContain("less than the 86400 s quiet window")
        expect(premature.output).toContain("role durable_writer does not exist")

        const filled = yield* adopt({
          options: options("backfill", { table: "cli_invoices", batch: 1 }),
          actors,
        })

        expect(filled.output).toBe("public.cli_invoices: filled routing_key on 2 rows in 2 passes")

        const unenforced = yield* adopt({
          options: options("release", { table: "cli_invoices" }),
          actors,
        })

        expect(unenforced).toEqual({
          output: "public.cli_invoices is not enforced",
          exitCode: 1,
        })

        const status = yield* adopt({
          options: options("status", { entry: undefined }),
          actors: [],
        })

        expect(status.output).toContain(
          "public.cli_invoices  Invoicing  observe  0 rows without routing_key",
        )

        const cleared = yield* adopt({
          options: options("observe", { table: "cli_invoices", report: true, clear: true }),
          actors,
        })

        expect(cleared.output).not.toBe("No write was recorded")

        const empty = yield* adopt({
          options: options("observe", { table: "cli_invoices", report: true }),
          actors,
        })

        expect(empty.output).toBe("No write was recorded")

        const json = yield* adopt({
          options: options("status", { entry: undefined, json: true }),
          actors: [],
        })

        const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
          json.output,
        )

        expect(decoded).toMatchObject({
          tables: [{ table: "public.cli_invoices", mode: "observe", unbackfilled: 0 }],
        })

        if (database.url === undefined) return

        const cli = yield* runCli(["adopt", "status", "--database-url", database.url, "--json"])

        expect(cli.exitCode).toBe(0)
        expect(cli.stdout).toBe(`${json.output}\n`)
      }).pipe(Effect.provideContext(services))
    }).pipe(Effect.scoped, (effect) => runtime.runPromise(effect)))
})
