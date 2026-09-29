import { BunServices } from "@effect/platform-bun"
import { Clock, Console, Effect, ManagedRuntime, Option, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { afterAll, describe, expect, it } from "vitest"
import { decompress } from "../../../../runtime/storage/codec.ts"
import { endpoint, freePort, open, query, synchronousPair, until } from "./failover.ts"

const OPERATIONS = 120

interface Done {
  readonly started: number
  readonly latency: number
}

interface Process {
  readonly done: Array<Done>
  readonly acked: Set<string>
  ready: boolean
  finished: boolean
  exited: boolean
}

describe("Postgres primary failover under load with separate runner processes", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)
  afterAll(() => runtime.dispose())

  it(
    "resolves commit-unknown turns through receipts after the primary fails over",
    () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const pair = yield* synchronousPair("drill")

          const endpointPort = yield* freePort
          const database = yield* endpoint(endpointPort, pair.primaryPort)

          const spawn = Effect.fnUntraced(function* () {
            const process: Process = {
              done: [],
              acked: new Set(),
              ready: false,
              finished: false,
              exited: false,
            }

            const child = yield* spawner.spawn(
              ChildProcess.make("bun", [new URL("./runner.ts", import.meta.url).pathname], {
                env: {
                  DRILL_DATABASE_URL: `postgres://project@127.0.0.1:${endpointPort}/drill`,
                  DRILL_PORT: String(yield* freePort),
                  DRILL_OPERATIONS: String(OPERATIONS),
                },
                extendEnv: true,
                stderr: "inherit",
              }),
            )

            yield* child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.runForEach((line) =>
                Effect.sync(() => {
                  const [tag, first, started, latency] = line.split(" ")

                  if (tag === "READY") process.ready = true

                  if (tag === "FINISHED") process.finished = true

                  if (tag === "ACKED") process.acked.add(first!)

                  if (tag === "DONE")
                    process.done.push({ started: Number(started), latency: Number(latency) })
                }),
              ),
              Effect.forkScoped,
            )

            yield* child.exitCode.pipe(
              Effect.ignore,
              Effect.andThen(
                Effect.sync(() => {
                  process.exited = true
                }),
              ),
              Effect.forkScoped,
            )

            const start = Stream.run(Stream.make(new TextEncoder().encode("GO\n")), child.stdin)

            return { process, start }
          })

          // Concurrent first migrations race on a fresh database, so one runner migrates first.
          const first = yield* spawn()
          yield* until(
            Effect.sync(() => first.process.ready),
            "the migrating runner",
            "30 seconds",
          )
          const runners = [first, yield* spawn(), yield* spawn()]
          yield* until(
            Effect.sync(() => runners.every(({ process }) => process.ready)),
            "three runners",
            "30 seconds",
          )
          yield* Effect.forEach(runners, ({ start }) => start, { discard: true })

          yield* until(
            Effect.sync(() => runners.every(({ process }) => process.done.length >= 30)),
            "load on every runner",
            "60 seconds",
          )

          const acked = () => new Set(runners.flatMap(({ process }) => [...process.acked]))

          const drill = yield* open(pair.primaryPort, "drill")

          // Read on the primary directly, past the held endpoint.
          const committed = query<{ command_id: string }>(
            drill,
            "SELECT command_id FROM actor_receipts WHERE command IN ('Increment', 'Send')",
          ).pipe(Effect.map((rows) => rows.map(({ command_id }) => command_id)))

          // Held replies leave commits the primary made that no caller has
          // heard of. Hold until at least one exists, then kill the primary
          // with those replies still in flight: each is commit-unknown.
          const unknown = yield* Effect.gen(function* () {
            yield* database.hold

            const found = yield* Effect.gen(function* () {
              while (true) {
                const heard = acked()
                const pending = (yield* committed).filter((id) => !heard.has(id))

                if (pending.length > 0) return pending

                yield* Effect.sleep("20 millis")
              }
            }).pipe(Effect.timeoutOption("400 millis"))

            if (Option.isSome(found)) return found.value

            yield* database.release
            yield* Effect.sleep("200 millis")

            return yield* Effect.fail("no commit in flight")
          }).pipe(Effect.retry({ times: 50 }), Effect.orDie)

          // Every commit the primary made visible, taken while replies are held.
          const visible = yield* committed

          expect(runners.some(({ process }) => process.finished)).toBe(false)
          const killedAt = yield* Clock.currentTimeMillis
          yield* pair.kill
          yield* database.sever

          // Promotion follows at once: failure detection, which a real
          // failover manager adds, is not part of this measure.
          expect(yield* pair.promote).toBe(true)

          const promotedAt = yield* Clock.currentTimeMillis
          yield* database.route(pair.standbyPort)

          yield* until(
            Effect.suspend(() =>
              runners.some(({ process }) => process.exited && !process.finished)
                ? Effect.die(new Error("a runner exited before finishing its operations"))
                : Effect.succeed(runners.every(({ process }) => process.finished)),
            ),
            "runners to finish",
            "120 seconds",
          )

          const promoted = yield* open(pair.standbyPort, "drill")

          yield* until(
            query<{ count: number }>(
              promoted,
              "SELECT count(*)::int AS count FROM actor_outbox",
            ).pipe(Effect.map((rows) => rows[0]!.count === 0)),
            "the outbox to drain",
            "60 seconds",
          )

          const receipts = yield* query<{ command: string; command_id: string }>(
            promoted,
            "SELECT command, command_id FROM actor_receipts WHERE command IN ('Increment', 'Send', 'Add')",
          )

          const ids = new Set(receipts.map((receipt) => receipt.command_id))

          const total = (actorType: string) =>
            query<{ value: Uint8Array }>(
              promoted,
              `SELECT value FROM actor_state WHERE actor_type = '${actorType}' AND key = 'count'`,
            ).pipe(
              Effect.map((rows) =>
                rows.reduce((sum, row) => sum + Number(decompress(row.value)), 0),
              ),
            )

          const of = (command: string) =>
            receipts.filter((receipt) => receipt.command === command).length

          // Nothing a caller heard of, and nothing the old primary showed, is missing.
          const heard = acked()
          const lost = [...new Set([...heard, ...visible])].filter((id) => !ids.has(id))
          expect(lost).toEqual([])

          // Each commit-unknown caller retried under the same id and was
          // answered from its receipt.
          expect(unknown.filter((id) => !heard.has(id))).toEqual([])

          // Every operation committed once: a duplicated transition would
          // leave state ahead of its receipts.
          expect(runners.map(({ process }) => process.done.length)).toEqual([
            OPERATIONS,
            OPERATIONS,
            OPERATIONS,
          ])
          expect(of("Increment")).toBe(3 * OPERATIONS)
          expect(of("Send")).toBe(3 * OPERATIONS)
          expect(of("Add")).toBe(3 * OPERATIONS)
          expect(yield* total("DrillCounter")).toBe(of("Increment"))
          expect(yield* total("DrillReceiver")).toBe(of("Add"))

          // Each runner's operation in flight at the kill waited out the
          // failover; the last of them to commit marks every runner serving.
          const resumed = runners.map(({ process }) =>
            Math.min(
              ...process.done
                .map(({ started, latency }) => started + latency)
                .filter((at) => at >= killedAt),
            ),
          )

          const recovery = Math.max(...resumed) - killedAt

          const worst = Math.max(
            ...runners.flatMap(({ process }) => process.done.map(({ latency }) => latency)),
          )

          // Tagged so a drill run's recovery can be read from the test output.
          yield* Console.error(
            `FAILOVER increments=${of("Increment")} sends=${of("Send")} adds=${of("Add")} commitUnknown=${unknown.length} lost=${lost.length} promoteMs=${promotedAt - killedAt} recoveryMs=${recovery} worstCommandMs=${worst}`,
          )
        }).pipe(Effect.scoped, Effect.timeout("5 minutes")),
      ),
    330_000,
  )
})
