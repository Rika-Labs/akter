import { Actor, User } from "@durable-actors/core"
import { ActorTest } from "@durable-actors/core/testing"
import { BunCrypto } from "@effect/platform-bun"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { Clock, Config, Crypto, Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { UsageError } from "../workflows/check.ts"
import { adopt, parseAdopt, parseWindow, type AdoptOptions } from "./run.ts"

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
  databaseUrl: "postgres://unused",
  table: undefined,
  json: false,
  report: false,
  clear: false,
  sinceMs: undefined,
  batch: undefined,
  ...rest,
})

const runtime = ManagedRuntime.make(BunCrypto.layer)

afterAll(() => runtime.dispose())

const postgres = runtime.runSync(Config.String("CLI_BACKEND")) === "postgres"

describe("durable adopt arguments", () => {
  it("reads a table, the window, and every flag of each command", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* parseAdopt({
            args: [
              "observe",
              "invoices",
              "--report",
              "--since",
              "7d",
              "--clear",
              "--entry",
              "e.ts",
              "--database-url",
              "postgres://x",
            ],
            nowMs: 10 * 86_400_000,
          }),
        ).toEqual(
          options("observe", {
            entry: "e.ts",
            databaseUrl: "postgres://x",
            table: "invoices",
            report: true,
            clear: true,
            sinceMs: 3 * 86_400_000,
          }),
        )

        expect(
          yield* parseAdopt({
            args: [
              "backfill",
              "invoices",
              "--batch",
              "50",
              "--entry",
              "e.ts",
              "--database-url",
              "u",
            ],
            nowMs: 0,
          }),
        ).toMatchObject({ command: "backfill", table: "invoices", batch: 50 })

        expect(
          yield* parseAdopt({ args: ["status", "--database-url", "u"], nowMs: 0 }),
        ).toMatchObject({ command: "status", entry: undefined })

        expect(yield* parseWindow({ flag: "--since", text: "12h" })).toBe(43_200_000)
      }),
    ))

  it("refuses an unknown command, a missing flag, a flag on the wrong command, and a bad window or batch", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const refused = (args: ReadonlyArray<string>) =>
          parseAdopt({ args, nowMs: 0 }).pipe(Effect.flip)

        const base = ["--entry", "e.ts", "--database-url", "u"]

        for (const [args, message] of [
          [["migrate", ...base], "Unknown adopt command: migrate"],
          [["plan", "--entry", "e.ts"], "--database-url is required"],
          [["plan", "--database-url", "u"], "--entry is required"],
          [["observe", ...base], "observe takes the table to observe"],
          [["backfill", ...base], "backfill takes the table to backfill"],
          [["plan", "--report", ...base], "--report belongs to observe"],
          [
            ["observe", "t", "--since", "7d", ...base],
            "--since and --clear belong to observe --report",
          ],
          [["plan", "--batch", "5", ...base], "--batch belongs to backfill"],
          [["backfill", "t", "--batch", "0", ...base], "--batch takes a positive integer"],
          [
            ["observe", "t", "--report", "--since", "week", ...base],
            "--since takes a window such as 30m, 12h, or 7d",
          ],
          [["plan", "--force", ...base], "Unknown argument: --force"],
        ] as const) {
          const error = yield* refused(args)

          expect(error).toBeInstanceOf(UsageError)
          expect(error.message).toBe(message)
        }
      }),
    ))
})

const provisioned = Effect.gen(function* () {
  const backend = yield* Config.String("CLI_BACKEND")

  const as = User.make({ subject: "alice" })

  if (backend !== "postgres") return ActorTest.layer({ as })

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

  return ActorTest.layer({ database: Redacted.make(base.href), as })
})

describe(`durable adopt against ${postgres ? "Postgres" : "PGlite"}`, () => {
  it("plans, observes, reports legacy writers, backfills, and reports status; each refusal exits 1", () =>
    Effect.gen(function* () {
      const database = yield* provisioned
      const services = yield* Layer.build(database)

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

        const unknown = yield* adopt({ options: options("observe", { table: "missing" }), actors })

        expect(unknown).toEqual({
          output: "No actor type adopts a table named missing",
          exitCode: 1,
        })

        const observed = yield* adopt({
          options: options("observe", { table: "cli_invoices" }),
          actors,
        })

        expect(observed).toEqual({ output: "public.cli_invoices is observing", exitCode: 0 })

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

        const filled = yield* adopt({
          options: options("backfill", { table: "cli_invoices", batch: 1 }),
          actors,
        })

        expect(filled.output).toBe("public.cli_invoices: filled routing_key on 2 rows in 2 passes")

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
      }).pipe(Effect.provideContext(services))
    }).pipe(Effect.scoped, (effect) => runtime.runPromise(effect)))
})
