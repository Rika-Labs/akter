import { fileURLToPath } from "node:url"
import { BunCrypto } from "@effect/platform-bun"
import { Config, Crypto, Effect, ManagedRuntime } from "effect"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { runCli } from "../../testing.ts"

const runtime = ManagedRuntime.make(BunCrypto.layer)

afterAll(() => runtime.dispose())

const postgres = runtime.runSync(Config.String("CLI_BACKEND")) === "postgres"

const entry = fileURLToPath(
  new URL("../../../../../packages/akter/src/testing/conformance/fleet.ts", import.meta.url),
)

describe("durable fleet arguments", () => {
  it("refuses a missing flag or view with exit status 2", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        for (const args of [
          ["fleet", "setup", "--entry", entry],
          ["fleet", "setup", "--database-url", "postgres://db"],
          ["fleet", "rebuild", "--database-url", "postgres://db"],
        ]) {
          const result = yield* runCli(args)

          expect(result.exitCode).toBe(2)
        }
      }),
    ))
})

/**
 * Creating a logical slot waits for every transaction open on the server, and
 * the integration suites of other packages share that server, so setup can
 * wait on them.
 */
const SETUP_TIMEOUT_MS = 90_000

describe.skipIf(!postgres)("durable fleet setup on Postgres", () => {
  it(
    "gives the entry's sources full replica identity, publishes them, creates the slot once, and refuses an unknown rebuild",
    () =>
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
              const refused = yield* runCli([
                "fleet",
                "setup",
                "--entry",
                entry,
                "--database-url",
                base.href,
              ])

              expect(refused.exitCode).not.toBe(0)
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
            const first = yield* runCli(args)

            expect(first.stderr).toBe("")
            expect(first.stdout).toContain("Replication slot durable_fleet: created")

            const again = yield* runCli(args)

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

            const unknown = yield* runCli([
              "fleet",
              "rebuild",
              "Missing",
              "--database-url",
              base.href,
            ])

            expect(unknown.exitCode).toBe(1)
            expect(unknown.stdout).toContain("No fleet view Missing is registered")
          }),
        ),
      ),
    SETUP_TIMEOUT_MS,
  )
})
