import { expect, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer } from "effect"
import { creates, flyClient, flyFake, type FlyScript } from "./fly-fake.ts"
import type { FlyOptions } from "./fly.ts"
import { flyMigrations, ImageMigrations } from "./migrations.ts"

const options = {
  organization: "rika-labs-test",
  regions: { "us-east-1": { region: "iad" } },
  appPrefix: "akter-pr-12-run-",
  port: 8080,
  guest: { cpuKind: "shared", cpus: 1, memoryMb: 512 },
  command: ["bun", "run", "migrate"],
} as const satisfies FlyOptions

const input = {
  deploymentId: "migration-test",
  region: "us-east-1",
  image: `registry.fly.io/akter-images@sha256:${"a".repeat(64)}`,
  environment: { DATABASE_URL: "postgres://cell/db" },
  idempotencyKey: "migration-job",
}

const harness = (script: FlyScript) =>
  Effect.gen(function* () {
    const fake = yield* flyFake(script)
    const context = yield* Layer.build(
      flyMigrations(options).pipe(Layer.provide(flyClient(fake.url))),
    )

    return { ...fake, migrations: Context.get(context, ImageMigrations) }
  })

for (const code of [0, 19, undefined])
  it.effect(
    `requires the migration process's recorded exit code 0, not only a stopped machine (${String(code)})`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { calls, apps, migrations } = yield* harness({
            createdAs: { state: "stopped", exit: { code } },
          })

          const result = yield* migrations.run(input).pipe(Effect.exit)

          const config = creates(calls)[0]?.config

          expect(result._tag).toBe(code === 0 ? "Success" : "Failure")
          expect(config?.init).toEqual({ cmd: ["bun", "run", "migrate"] })
          expect(config?.env).toEqual({ DATABASE_URL: "postgres://cell/db" })
          expect(config?.services).toBeUndefined()
          expect(calls.some((call) => call.path.endsWith("/ip_assignments"))).toBe(false)
          expect([...apps.values()].flatMap((app) => app.machines)).toHaveLength(0)
          expect(calls.at(-1)?.method).toBe("DELETE")
        }),
      ),
  )

it.live("waits for the machine to exit rather than judging it while it still runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { calls, apps, migrations } = yield* harness({ createdAs: { state: "started" } })

      const run = yield* Effect.forkChild(migrations.run(input).pipe(Effect.exit))

      yield* Effect.sleep("300 millis")

      const machine = [...apps.values()][0]!.machines[0]!

      expect(machine.state).toBe("started")
      expect(calls.some((call) => call.method === "DELETE")).toBe(false)

      machine.state = "stopped"
      machine.events = [{ type: "exit", timestamp: 9, request: { exit_event: { exit_code: 0 } } }]

      const result = yield* Fiber.join(run)

      expect(result._tag).toBe("Success")
      expect(
        calls.filter((call) => call.method === "GET" && call.path.endsWith(machine.id)).length,
      ).toBeGreaterThanOrEqual(2)
      expect(apps.size).toBe(1)
      expect([...apps.values()][0]?.machines).toHaveLength(0)
    }),
  ),
)

const machineReads = (calls: ReadonlyArray<{ readonly method: string; readonly path: string }>) =>
  calls.filter((call) => call.method === "GET" && /\/machines\/[^/]+$/u.test(call.path)).length

it.effect("destroys the machine when reading its exit fails after it started", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let reads = 0
      const { calls, apps, migrations } = yield* harness({
        createdAs: { state: "stopped", exit: { code: 0 } },
        override: (call) =>
          call.method === "GET" && /\/machines\/[^/]+$/u.test(call.path) && ++reads === 2
            ? { status: 500, body: { error: "read failed" } }
            : undefined,
      })

      const result = yield* migrations.run(input).pipe(Effect.exit)

      expect(result._tag).toBe("Failure")
      expect(machineReads(calls)).toBeGreaterThan(2)
      expect([...apps.values()].flatMap((app) => app.machines)).toHaveLength(0)
      expect(calls.at(-1)?.method).toBe("DELETE")
    }),
  ),
)

it.live("destroys the machine when the migration is interrupted while it runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { calls, apps, migrations } = yield* harness({ createdAs: { state: "started" } })

      const run = yield* Effect.forkChild(migrations.run(input))

      yield* Effect.sleep("300 millis")

      expect([...apps.values()][0]?.machines).toHaveLength(1)

      yield* Fiber.interrupt(run)

      expect([...apps.values()][0]?.machines).toHaveLength(0)
      expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/stop"))).toBe(true)
    }),
  ),
)

it.effect("keeps a successful migration's result when removing its machine fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { calls, migrations } = yield* harness({
        createdAs: { state: "stopped", exit: { code: 0 } },
        override: (call) =>
          call.method === "DELETE" ? { status: 500, body: { error: "delete failed" } } : undefined,
      })

      const result = yield* migrations.run(input).pipe(Effect.exit)

      expect(result._tag).toBe("Success")
      expect(calls.at(-1)?.method).toBe("DELETE")
    }),
  ),
)
