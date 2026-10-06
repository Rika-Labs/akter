import { BunCrypto } from "@effect/platform-bun"
import { migrate } from "@akter/postgres/migrate"
import { liveNeki, nekiDatabase } from "@akter/postgres/neki"
import { Config, Crypto, Effect, ManagedRuntime, Redacted } from "effect"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { runCli, runCliWith } from "../../testing.ts"

const runtime = ManagedRuntime.make(BunCrypto.layer)

afterAll(() => runtime.dispose())

const postgres = runtime.runSync(Config.String("CLI_BACKEND")) === "postgres"

const valid = [
  "tenants",
  "create",
  "acme",
  "--deployment",
  "dep-1",
  "--region",
  "us-east",
  "--database-url",
  "postgres://127.0.0.1:1/control",
  "--operator",
  "ops@example.com",
]

describe("akter tenants create arguments", () => {
  it("reads the tenant and every required flag before it opens the control plane", () =>
    Effect.gen(function* () {
      const unreachable = yield* runCli(valid)

      expect(unreachable.exitCode).not.toBe(0)
      expect(unreachable.stderr).toContain("Failed to connect")
      expect(unreachable.stderr).not.toContain("USAGE")
    }).pipe(Effect.runPromise))

  it("refuses a missing flag, an unknown argument, and a tenant or region outside its limits", () =>
    Effect.gen(function* () {
      const refused = [
        [valid.slice(0, 9), "MissingOption", "Missing required flag: --operator"],
        [[...valid, "--force"], "UnrecognizedOption", "Unrecognized flag: --force"],
        [[...valid, "--engine", "mysql"], "InvalidValue", "--engine"],
        [
          [...valid.slice(0, 2), "bad tenant", ...valid.slice(3)],
          "InvalidValue",
          'Invalid value for argument <tenant>: "bad tenant"',
        ],
        [
          [...valid.slice(0, 6), "US East", ...valid.slice(7)],
          "InvalidValue",
          'Invalid value for flag --region: "US East"',
        ],
        [
          [...valid.slice(0, 2), ...valid.slice(3)],
          "MissingArgument",
          "Missing required argument: tenant",
        ],
      ] as const

      for (const [args, reason, error] of refused) {
        const exit = yield* runCli(args)

        expect(exit).toMatchObject({ exitCode: 2, reason })
        expect(exit.stderr).toContain(error)
      }
    }).pipe(Effect.runPromise))
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

describe.skipIf(!postgres)("akter tenants create on Postgres", () => {
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

            const created = yield* runCli(args("us-east"))

            expect(created).toEqual({
              stdout: "dep-1/acme lives in us-east (active)\n",
              stderr: "",
              exitCode: 0,
              reason: "",
            })

            const refused = yield* runCli(args("eu-west"))

            expect(refused).toMatchObject({ exitCode: 2, reason: "UsageError" })
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

  it(
    "runs TenantHome on a Neki control plane when CONTROL_PLANE_DATABASE_ENGINE says neki",
    () =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const url = Redacted.value(yield* nekiDatabase("cli"))
            yield* Effect.promise(() => migrate(url, { neki: true }))
            const pool = yield* Effect.acquireRelease(
              Effect.sync(() => new Pool({ connectionString: url, max: 1 })),
              (opened) => Effect.promise(() => opened.end()),
            )
            const barriers = () =>
              Effect.promise(() => pool.query("SELECT calls FROM neki_barriers")).pipe(
                Effect.map((result) => Number(result.rows[0].calls)),
              )
            const before = liveNeki === undefined ? yield* barriers() : 0
            yield* Effect.promise(() =>
              pool.query("INSERT INTO deployment (id, primary_region) VALUES ('dep-1', 'us-east')"),
            )

            const created = yield* runCliWith({ env: { CONTROL_PLANE_DATABASE_ENGINE: "neki" } })([
              "tenants",
              "create",
              "acme",
              "--deployment",
              "dep-1",
              "--region",
              "us-east",
              "--database-url",
              url,
              "--operator",
              "ops@example.com",
            ])

            expect(created).toEqual({
              stdout: "dep-1/acme lives in us-east (active)\n",
              stderr: "",
              exitCode: 0,
              reason: "",
            })
            if (liveNeki === undefined) expect(yield* barriers()).toBeGreaterThan(before)
            const rows = yield* Effect.promise(() =>
              pool.query("SELECT tenant, region FROM tenant_directory"),
            )
            expect(rows.rows).toEqual([{ tenant: "acme", region: "us-east" }])
          }),
        ),
      ),
    900_000,
  )
})
