import { createServer } from "node:net"
import { BunServices } from "@effect/platform-bun"
import {
  Clock,
  Config,
  Console,
  Crypto,
  type Duration,
  Effect,
  ManagedRuntime,
  Schema,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { decompress } from "../../../../runtime/storage/codec.ts"

const OPERATIONS = 120

const REPLACEMENT_OPERATIONS = 60

const isBound = Schema.is(Schema.Struct({ port: Schema.Int }))

/** A port the OS just handed out, so each runner process can listen on its own. */
const freePort = Effect.callback<number>((resume) => {
  const server = createServer()
  server.once("error", (error) => resume(Effect.die(error)))
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    server.close(() =>
      resume(
        isBound(address)
          ? Effect.succeed(address.port)
          : Effect.die(new Error("the probe socket has no port")),
      ),
    )
  })
})

interface Done {
  readonly index: number
  readonly started: number
  readonly latency: number
  readonly ids: ReadonlyArray<string>
  readonly shards: ReadonlyArray<string>
}

interface Process {
  readonly done: Array<Done>
  ready: boolean
  claimed: boolean
  finished: boolean
}

describe("runner and relay process death with Postgres", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)
  afterAll(() => runtime.dispose())

  it(
    "loses and duplicates no work when a runner and a claiming relay are SIGKILLed under load",
    () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const database = new URL(yield* Config.String("TEST_DATABASE_URL"))
          const name = `drill_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

          const admin = yield* Effect.acquireRelease(
            Effect.sync(() => new Pool({ connectionString: database.href })),
            (pool) => Effect.promise(() => pool.end()),
          )

          yield* Effect.acquireRelease(
            Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
            () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
          )
          database.pathname = `/${name}`

          const pool = yield* Effect.acquireRelease(
            Effect.sync(() => new Pool({ connectionString: database.href })),
            (db) => Effect.promise(() => db.end()),
          )

          const query = <A>(text: string) =>
            Effect.promise(() => pool.query(text)).pipe(
              Effect.map((result) => result.rows as Array<A>),
            )

          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

          const spawn = Effect.fnUntraced(function* (
            operations: number,
            options: { readonly blockRelay?: boolean; readonly holdAt?: number } = {},
          ) {
            const process: Process = {
              done: [],
              ready: false,
              claimed: false,
              finished: false,
            }

            const port = yield* freePort

            const child = yield* spawner.spawn(
              ChildProcess.make("bun", [new URL("./runner.ts", import.meta.url).pathname], {
                env: {
                  DRILL_DATABASE_URL: database.href,
                  DRILL_PORT: String(port),
                  DRILL_OPERATIONS: String(operations),
                  DRILL_BLOCK_RELAY: String(options.blockRelay ?? false),
                  DRILL_HOLD_AT: String(options.holdAt ?? operations),
                },
                extendEnv: true,
                stdin: { stream: "pipe", endOnDone: false },
                stderr: "inherit",
              }),
            )

            yield* child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.runForEach((line) =>
                Effect.sync(() => {
                  const [
                    tag,
                    index,
                    started,
                    latency,
                    incrementId,
                    sendId,
                    counterShard,
                    senderShard,
                  ] = line.split(" ")

                  if (tag === "READY") process.ready = true

                  if (tag === "CLAIMED") process.claimed = true

                  if (tag === "FINISHED") process.finished = true

                  if (tag === "DONE")
                    process.done.push({
                      index: Number(index),
                      started: Number(started),
                      latency: Number(latency),
                      ids: [incrementId!, sendId!],
                      shards: [counterShard!, senderShard!],
                    })
                }),
              ),
              Effect.forkScoped,
            )

            const send = (line: string) =>
              Stream.run(Stream.make(new TextEncoder().encode(`${line}\n`)), child.stdin)

            return { child, process, port, start: send("GO"), resume: send("RESUME") }
          })

          const until = (condition: () => boolean, what: string, within: Duration.Input) =>
            Effect.gen(function* () {
              while (!condition()) yield* Effect.sleep("100 millis")
            }).pipe(
              Effect.timeoutOrElse({
                duration: within,
                orElse: () => Effect.die(new Error(`timed out waiting for ${what}`)),
              }),
            )

          const killed = Effect.fnUntraced(function* (
            child: ChildProcessSpawner.ChildProcessHandle,
          ) {
            yield* child.kill({ killSignal: "SIGKILL" })
            expect(String((yield* child.exitCode.pipe(Effect.flip)).cause)).toContain("SIGKILL")
          })

          const first = yield* spawn(OPERATIONS, { holdAt: OPERATIONS / 2 })
          yield* until(() => first.process.ready, "the migrating runner", "30 seconds")
          const second = yield* spawn(OPERATIONS)
          const third = yield* spawn(OPERATIONS, { blockRelay: true })
          yield* until(
            () => [first, second, third].every(({ process }) => process.ready),
            "three runners",
            "30 seconds",
          )
          yield* Effect.forEach([first, second, third], ({ start }) => start, { discard: true })

          yield* until(() => second.process.done.length >= 30, "r1 under load", "60 seconds")

          const dead = new Set(
            (yield* query<{ shard_id: string }>(
              `SELECT shard_id FROM cluster_locks WHERE address = '127.0.0.1:${second.port}'`,
            )).map(({ shard_id }) => shard_id),
          )

          expect(dead.size > 0).toBe(true)
          const killedAt = yield* Clock.currentTimeMillis
          expect(first.process.finished).toBe(false)
          yield* killed(second.child)
          yield* first.resume
          yield* until(() => third.process.claimed, "r2's relay claim", "60 seconds")
          yield* killed(third.child)

          const fourth = yield* spawn(REPLACEMENT_OPERATIONS)
          const fifth = yield* spawn(REPLACEMENT_OPERATIONS)
          yield* Effect.forEach([fourth, fifth], ({ start }) => start, { discard: true })
          const survivors = [first, fourth, fifth]
          yield* until(
            () => survivors.every(({ process }) => process.finished),
            "survivors to finish",
            "120 seconds",
          )

          const outbox = () =>
            query<{ count: number }>("SELECT count(*)::int AS count FROM actor_outbox").pipe(
              Effect.map((rows) => rows[0]!.count),
            )

          const drained = Effect.gen(function* () {
            while ((yield* outbox()) > 0) yield* Effect.sleep("100 millis")
          })

          yield* drained.pipe(
            Effect.timeoutOrElse({
              duration: "60 seconds",
              orElse: () => Effect.die(new Error("the outbox never drained")),
            }),
          )

          const receipts = yield* query<{ command: string; command_id: string }>(
            "SELECT command, command_id FROM actor_receipts WHERE command IN ('Increment', 'Send', 'Add')",
          )

          const ids = new Set(receipts.map((receipt) => receipt.command_id))

          const total = (actorType: string) =>
            query<{ value: Uint8Array }>(
              `SELECT value FROM actor_state WHERE actor_type = '${actorType}' AND key = 'count'`,
            ).pipe(
              Effect.map((rows) =>
                rows.reduce((sum, row) => sum + Number(decompress(row.value)), 0),
              ),
            )

          const of = (command: string) =>
            receipts.filter((receipt) => receipt.command === command).length

          const lost = [first, second, third, fourth, fifth].flatMap(({ process }) =>
            process.done.flatMap(({ ids: minted }) => minted.filter((id) => !ids.has(id))),
          )

          expect(lost).toEqual([])
          expect(survivors.map(({ process }) => process.done.length)).toEqual([
            OPERATIONS,
            REPLACEMENT_OPERATIONS,
            REPLACEMENT_OPERATIONS,
          ])

          expect(yield* total("DrillCounter")).toBe(of("Increment"))
          expect(of("Add")).toBe(of("Send"))
          expect(yield* total("DrillReceiver")).toBe(of("Send"))

          const afterKill = first.process.done.filter(({ started }) => started >= killedAt)
          expect(afterKill.length >= OPERATIONS / 2).toBe(true)

          const routedToDead = afterKill.filter(({ shards }) =>
            shards.some((shard) => dead.has(shard)),
          )

          expect(routedToDead.length > 0).toBe(true)

          const stalled = routedToDead.reduce((slowest, done) =>
            done.latency > slowest.latency ? done : slowest,
          )

          const recovery = stalled.started + stalled.latency - killedAt

          const worst = Math.max(
            ...survivors.flatMap(({ process }) => process.done.map(({ latency }) => latency)),
          )

          yield* Console.error(
            `DRILL increments=${of("Increment")} sends=${of("Send")} adds=${of("Add")} lost=${lost.length} recoveryMs=${recovery} worstCommandMs=${worst}`,
          )
        }).pipe(Effect.scoped, Effect.timeout("5 minutes")),
      ),
    330_000,
  )
})
