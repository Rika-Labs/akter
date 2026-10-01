import { BunCrypto } from "@effect/platform-bun"
import { ActorTest } from "@durable-actors/core/testing"
import { migrate } from "@durable-actors/postgres/migrate"
import {
  Config,
  Context,
  Crypto,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Redacted,
} from "effect"
import { SqlClient } from "effect/sql"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { DeploymentsLive } from "../deployment/repository.ts"
import {
  NotPrimaryRegion,
  TenantAlreadyHomed,
  TenantHome,
  tenantHomeKey,
  UnknownDeployment,
} from "./contract.ts"
import { TenantHomeCommands } from "./layer.ts"
import { TenantHomeReads } from "./queries.ts"

/** A fresh control-plane database with every packages/postgres migration applied. */
const database = Effect.gen(function* () {
  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `tenants_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: base.href })),
    (pool) => Effect.promise(() => pool.end()),
  )

  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
    () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
  )
  base.pathname = `/${name}`
  yield* Effect.promise(() => migrate(base.href))

  return Redacted.make(base.href)
})

class DatabaseUrl extends Context.Service<DatabaseUrl, Redacted.Redacted<string>>()(
  "@durable-actors/deployments/tenant-home/layer.test/DatabaseUrl",
) {}

const live = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* database
    const test = ActorTest.layer({ database: url })

    return Layer.mergeAll(
      TenantHomeCommands,
      TenantHomeReads,
      Layer.succeed(DatabaseUrl, url),
    ).pipe(Layer.provide(DeploymentsLive), Layer.provideMerge(test))
  }),
).pipe(Layer.provide(BunCrypto.layer), Layer.orDie)

const runtime = ManagedRuntime.make(live)

afterAll(() => runtime.dispose())

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof live>>) =>
  runtime.runPromise(effect)

const deployment = (id: string, primaryRegion: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* sql`INSERT INTO deployment (id, primary_region) VALUES (${id}, ${primaryRegion})`
  }).pipe(Effect.orDie)

/** A connection outside the runtime, returned to its own pool with the scope. */
const connection = Effect.fnUntraced(function* (url: Redacted.Redacted<string>) {
  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: Redacted.value(url), max: 1 })),
    (opened) => Effect.promise(() => opened.end()),
  )

  return yield* Effect.acquireRelease(
    Effect.promise(() => pool.connect()),
    (client) => Effect.sync(() => client.release()),
  )
})

const directory = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return yield* sql<{
      readonly tenant: string
      readonly region: string
      readonly state: string
      readonly version: string
    }>`
      SELECT tenant, region, state, version::text AS version
      FROM tenant_directory WHERE deployment_id = ${id} ORDER BY version
    `
  }).pipe(Effect.orDie)

describe("TenantHome", () => {
  it("records a tenant's home in the primary region, and returns it again for a repeated create", () =>
    run(
      Effect.gen(function* () {
        yield* deployment("dep-a", "us-east")
        const home = yield* TenantHome.get(tenantHomeKey({ deployment: "dep-a", tenant: "acme" }))

        expect(yield* home.Lookup()).toBe(undefined)

        const created = yield* home.Create({ region: "us-east" })

        expect(created).toEqual({
          deployment: "dep-a",
          tenant: "acme",
          region: "us-east",
          state: "active",
        })
        expect(yield* home.Create({ region: "us-east" })).toEqual(created)
        expect(yield* home.Lookup()).toEqual(created)

        const rows = yield* directory("dep-a")

        expect(rows.map(({ tenant, region, state }) => ({ tenant, region, state }))).toEqual([
          { tenant: "acme", region: "us-east", state: "active" },
        ])
        expect(Number(rows[0]!.version)).toBeGreaterThan(0)
      }),
    ))

  it("refuses a region other than the primary, an unknown deployment, and a second region, writing nothing", () =>
    run(
      Effect.gen(function* () {
        yield* deployment("dep-b", "eu-west")
        const home = yield* TenantHome.get(tenantHomeKey({ deployment: "dep-b", tenant: "globex" }))
        const elsewhere = yield* home.Create({ region: "us-east" }).pipe(Effect.exit)

        expect(elsewhere).toEqual(
          Exit.fail(NotPrimaryRegion.make({ region: "us-east", primaryRegion: "eu-west" })),
        )

        const unknown = yield* (yield* TenantHome.get(
          tenantHomeKey({ deployment: "dep-none", tenant: "globex" }),
        ))
          .Create({ region: "eu-west" })
          .pipe(Effect.exit)

        expect(unknown).toEqual(Exit.fail(UnknownDeployment.make({ deployment: "dep-none" })))
        expect(yield* directory("dep-b")).toEqual([])

        yield* home.Create({ region: "eu-west" })
        const moved = yield* home.Create({ region: "us-east" }).pipe(Effect.exit)

        expect(moved).toEqual(Exit.fail(TenantAlreadyHomed.make({ region: "eu-west" })))
        expect((yield* directory("dep-b")).map(({ region }) => region)).toEqual(["eu-west"])
      }),
    ))

  it("gives every change a new version, and a later commit never a lower one", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          yield* deployment("dep-c", "us-east")
          const tenants = Array.from({ length: 12 }, (_, index) => `tenant-${index}`)

          yield* Effect.forEach(
            tenants,
            (tenant) =>
              Effect.flatMap(
                TenantHome.get(tenantHomeKey({ deployment: "dep-c", tenant })),
                (home) => home.Create({ region: "us-east" }),
              ),
            { concurrency: "unbounded" },
          )

          const versions = (yield* directory("dep-c")).map(({ version }) => Number(version))

          expect(new Set(versions).size).toBe(tenants.length)

          const url = yield* DatabaseUrl
          const first = yield* connection(url)
          const second = yield* connection(url)

          const insert = (tenant: string) =>
            `INSERT INTO tenant_directory (routing_key, tenant_id, actor_id, deployment_id, tenant, region, state)
           VALUES (0, 'default', 'dep-c/${tenant}', 'dep-c', '${tenant}', 'us-east', 'active') RETURNING version::int AS version`

          yield* Effect.promise(() => first.query("BEGIN"))

          const held = yield* Effect.promise(() => first.query(insert("held")))

          const waiting = yield* Effect.promise(() => second.query(insert("waiting"))).pipe(
            Effect.forkChild,
          )

          yield* Effect.sleep("300 millis")
          expect(waiting.pollUnsafe()).toBe(undefined)

          yield* Effect.promise(() => first.query("COMMIT"))
          const later = yield* Fiber.join(waiting)

          expect(later.rows[0].version).toBeGreaterThan(held.rows[0].version)
        }),
      ),
    ))
})
