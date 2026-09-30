import { BunCrypto } from "@effect/platform-bun"
import { migrate } from "@durable-actors/postgres/migrate"
import { Config, Crypto, Effect, ManagedRuntime } from "effect"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { parseCreate, UsageError } from "./create.ts"

const runtime = ManagedRuntime.make(BunCrypto.layer)

afterAll(() => runtime.dispose())

const postgres = runtime.runSync(Config.String("CLI_BACKEND")) === "postgres"

const valid = [
  "acme",
  "--deployment",
  "dep-1",
  "--region",
  "us-east",
  "--database-url",
  "postgres://localhost/control",
  "--operator",
  "ops@example.com",
]

describe("durable tenants create arguments", () => {
  it("reads the tenant and every required flag", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* parseCreate(valid)).toEqual({
          tenant: "acme",
          deployment: "dep-1",
          region: "us-east",
          databaseUrl: "postgres://localhost/control",
          operator: "ops@example.com",
        })
      }),
    ))

  it("refuses a missing flag, an unknown argument, and a tenant or region outside its limits", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const refused = [
          [valid.slice(0, 7), "--operator is required"],
          [[...valid, "--force"], "Unknown argument: --force"],
          [["bad tenant", ...valid.slice(1)], 'tenant "bad tenant" is not valid'],
          [[...valid.slice(0, 4), "US East", ...valid.slice(5)], '--region "US East" is not valid'],
          [valid.slice(1), "<tenant> is required"],
        ] as const

        for (const [args, message] of refused) {
          const failure = yield* parseCreate(args).pipe(Effect.flip)

          expect(failure).toBeInstanceOf(UsageError)
          expect(failure.message).toBe(message)
        }
      }),
    ))
})

/** A fresh control-plane database with every packages/postgres migration applied. */
const controlPlane = Effect.gen(function* () {
  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `cli_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

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

  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: base.href })),
    (opened) => Effect.promise(() => opened.end()),
  )

  return { url: base.href, pool }
})

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

describe.skipIf(!postgres)("durable tenants create on Postgres", () => {
  it(
    "records the home through TenantHome, attributed to the operator, and refuses another region",
    () =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { url, pool } = yield* controlPlane

            yield* Effect.promise(() =>
              pool.query("INSERT INTO deployment (id, primary_region) VALUES ('dep-1', 'us-east')"),
            )

            const args = (region: string) => [
              "tenants",
              "create",
              "acme",
              "--deployment",
              "dep-1",
              "--region",
              region,
              "--database-url",
              url,
              "--operator",
              "ops@example.com",
            ]

            const created = yield* cli(args("us-east"))

            expect(created).toMatchObject({
              code: 0,
              stdout: "dep-1/acme lives in us-east (active)\n",
            })

            const refused = yield* cli(args("eu-west"))

            expect(refused.code).toBe(2)
            expect(refused.stderr).toContain("already lives in us-east")

            const rows = yield* Effect.promise(() =>
              pool.query("SELECT tenant, region, state FROM tenant_directory"),
            )

            expect(rows.rows).toEqual([{ tenant: "acme", region: "us-east", state: "active" }])

            const receipts = yield* Effect.promise(() =>
              pool.query("SELECT caller_key FROM actor_receipts"),
            )

            expect(receipts.rows).toEqual([
              { caller_key: '["User","ops@example.com"]' },
              { caller_key: '["User","ops@example.com"]' },
            ])
          }),
        ),
      ),
    60_000,
  )
})
