import { BunServices } from "@effect/platform-bun"
import { Config, Effect, ManagedRuntime, Redacted, Schedule, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { ServedCounter } from "./client.ts"
import { disposableDatabase } from "../../database.ts"

const baseFetch = globalThis.fetch.bind(globalThis)

describe("Promise client across a served process death with Postgres", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)
  afterAll(() => runtime.dispose())

  for (const point of ["beforeCommit", "afterCommit"] as const) {
    it(
      `retries a command whose server was SIGKILLed ${point} with the same id, exactly once`,
      () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const database = new URL(
              Redacted.value(
                yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") }),
              ),
            )

            const pool = yield* Effect.acquireRelease(
              Effect.sync(() => new Pool({ connectionString: database.href })),
              (db) => Effect.promise(() => db.end()),
            )

            const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
            const port = probe.port
            yield* Effect.promise(() => probe.stop(true))

            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

            const command = (mode: string) =>
              ChildProcess.make("bun", [new URL("./client.ts", import.meta.url).pathname], {
                env: {
                  CRASH_DATABASE_URL: database.href,
                  CRASH_POINT: mode,
                  CRASH_PORT: String(port),
                },
                extendEnv: true,
                stderr: "inherit",
              })

            const child = yield* spawner.spawn(command(point))
            const keys: Array<string | null> = []
            let commandsSent = 0

            const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
              const url =
                input instanceof Request ? input.url : input instanceof URL ? input.href : input

              if (url.endsWith("/Increment")) {
                keys.push(new Headers(init?.headers).get("idempotency-key"))
                commandsSent += 1
              }

              return baseFetch(input, init)
            }

            const counter = ServedCounter.client({
              baseUrl: `http://127.0.0.1:${port}`,
              fetch,
              timeoutInMs: 30_000,
            }).get("crashed")

            yield* Effect.tryPromise(() => baseFetch(`http://127.0.0.1:${port}/protocol`)).pipe(
              Effect.filterOrFail((response) => response.ok),
              Effect.retry({ times: 100, schedule: Schedule.spaced("100 millis") }),
              Effect.orDie,
            )

            const call = counter.Increment(47)
            call.catch(() => undefined)

            yield* child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.filter((line) => line === "READY"),
              Stream.take(1),
              Stream.runCollect,
            )
            yield* child.kill({ killSignal: "SIGKILL" })
            expect(String((yield* child.exitCode.pipe(Effect.flip)).cause)).toContain("SIGKILL")

            const committed = point === "afterCommit" ? 1 : 0

            expect(
              (yield* Effect.promise(() =>
                pool.query("SELECT count(*)::int AS receipts FROM actor_receipts"),
              )).rows,
            ).toEqual([{ receipts: committed }])

            yield* spawner.spawn(command("serve"))

            const result = yield* Effect.tryPromise(() => call).pipe(
              Effect.match({
                onSuccess: (value) => ({ ok: true, value }),
                onFailure: (failure) => ({ ok: false, error: failure.cause }),
              }),
            )

            expect(result).toEqual({ ok: true, value: 47 })
            expect(commandsSent > 1).toBe(true)
            expect(new Set(keys).size).toBe(1)
            expect(keys[0]).toMatch(/^v1\.\d+\.\d+\./)

            const after = yield* Effect.promise(() =>
              pool.query(
                "SELECT (SELECT count(*)::int FROM actor_receipts) AS receipts, (SELECT count(*)::int FROM actor_events) AS events",
              ),
            )

            expect(after.rows).toEqual([{ receipts: 1, events: 1 }])
          }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
        ),
      45_000,
    )
  }
})
