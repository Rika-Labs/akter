import { fileURLToPath } from "node:url"
import { BunCrypto } from "@effect/platform-bun"
import { Config, Crypto, Effect, Exit, ManagedRuntime, Option, Schema } from "effect"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { UsageError } from "../workflows/check.ts"
import { parseFleet } from "./run.ts"

const runtime = ManagedRuntime.make(BunCrypto.layer)

afterAll(() => runtime.dispose())

const postgres = runtime.runSync(Config.String("CLI_BACKEND")) === "postgres"

describe("durable fleet arguments", () => {
  it("reads setup's entry and database, and rebuild's view and database", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* parseFleet(["setup", "--entry", "app.ts", "--database-url", "postgres://db"]),
        ).toEqual({ command: "setup", entry: "app.ts", databaseUrl: "postgres://db" })
        expect(
          yield* parseFleet(["rebuild", "OrdersByStatus", "--database-url", "postgres://db"]),
        ).toEqual({ command: "rebuild", view: "OrdersByStatus", databaseUrl: "postgres://db" })
      }),
    ))

  it("refuses an unknown command, a missing flag or view, and an entry on rebuild", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const refused = [
          ["drop"],
          ["setup", "--entry", "app.ts"],
          ["setup", "--database-url", "postgres://db"],
          ["rebuild", "--database-url", "postgres://db"],
          ["rebuild", "V", "--entry", "app.ts", "--database-url", "postgres://db"],
          ["setup", "--entry"],
        ]

        for (const args of refused) {
          const exit = yield* parseFleet(args).pipe(Effect.exit)

          expect(Option.exists(Exit.findErrorOption(exit), Schema.is(UsageError))).toBe(true)
        }
      }),
    ))
})

const entry = fileURLToPath(
  new URL(
    "../../../../../packages/durable-actors/src/testing/conformance/fleet.ts",
    import.meta.url,
  ),
)

const cli = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
  const child = Bun.spawn(["bun", new URL("../../main.ts", import.meta.url).pathname, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })

  const stdout = yield* Effect.promise(() => new Response(child.stdout).text())
  const stderr = yield* Effect.promise(() => new Response(child.stderr).text())
  const code = yield* Effect.promise(() => child.exited)

  return { stdout, stderr, code }
})

describe.skipIf(!postgres)("durable fleet setup on Postgres", () => {
  it("gives the entry's sources full replica identity, publishes them, creates the slot once, and refuses an unknown rebuild", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
          const name = `fleet_cli_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

          const admin = yield* Effect.acquireRelease(
            Effect.sync(() => new Pool({ connectionString: base.href })),
            (pool) => Effect.promise(() => pool.end()),
          )

          const [level] = (yield* Effect.promise(() => admin.query("SHOW wal_level"))).rows

          if (level.wal_level !== "logical") {
            const refused = yield* cli([
              "fleet",
              "setup",
              "--entry",
              entry,
              "--database-url",
              base.href,
            ])

            expect(refused.code).not.toBe(0)
            expect(refused.stderr).toContain("set wal_level = logical")

            return
          }

          yield* Effect.acquireRelease(
            Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
            () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
          )
          base.pathname = `/${name}`

          const pool = yield* Effect.acquireRelease(
            Effect.sync(() => new Pool({ connectionString: base.href })),
            (opened) =>
              Effect.promise(() =>
                opened
                  .query(
                    "SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE database = current_database()",
                  )
                  .then(() => opened.end()),
              ),
          )

          yield* Effect.promise(() =>
            pool.query(`CREATE TABLE fleet_orders (routing_key bigint, tenant_id text,
              actor_id text, id text, status text NOT NULL, region text NOT NULL,
              amount_cents bigint NOT NULL, archived boolean NOT NULL,
              PRIMARY KEY (routing_key, tenant_id, actor_id, id))`),
          )

          const args = ["fleet", "setup", "--entry", entry, "--database-url", base.href]
          const first = yield* cli(args)
          expect(first.stderr).toBe("")
          expect(first.stdout).toContain("Replication slot durable_fleet: created")

          const again = yield* cli(args)
          expect(again.stdout).toContain("Replication slot durable_fleet: kept")

          const [state] = (yield* Effect.promise(() =>
            pool.query(`SELECT c.relreplident AS identity,
                (SELECT array_agg(tablename::text) FROM pg_publication_tables
                  WHERE pubname = 'durable_fleet') AS published,
                (SELECT count(*)::int FROM pg_replication_slots
                  WHERE database = current_database() AND plugin = 'pgoutput') AS slots
              FROM pg_class c WHERE c.relname = 'fleet_orders'`),
          )).rows

          expect(state).toEqual({ identity: "f", published: ["fleet_orders"], slots: 1 })

          yield* Effect.promise(() =>
            pool.query(`CREATE TABLE actor_fleet_views (view_name text PRIMARY KEY,
              status text NOT NULL, last_error text, updated_at_ms bigint NOT NULL)`),
          )
          const unknown = yield* cli(["fleet", "rebuild", "Missing", "--database-url", base.href])
          expect(unknown.code).toBe(1)
          expect(unknown.stdout).toContain("No fleet view Missing is registered")
        }),
      ),
    ))
})
