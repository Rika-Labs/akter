import {
  Clock,
  Config,
  Console,
  Context,
  Duration,
  Effect,
  Latch,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
  Stream,
} from "effect"
import { user } from "../../../../packages/akter/src/index.ts"
import { RuntimeControl } from "../../../../packages/akter/src/server.ts"
import { CommandIds } from "../../../../packages/akter/src/execution/command-ids.ts"
import type { Catalog } from "../../../../packages/akter/src/execution/durable.ts"
import { Engine } from "../../../../packages/akter/src/execution/engine.ts"
import { Entry } from "../../../../packages/akter/src/execution/entries.ts"
import { pendingClocks } from "../../../../packages/akter/src/execution/workflow.ts"
import { Routing } from "../../../../packages/akter/src/runtime/sharding.ts"
import { s3Bucket } from "../../../../packages/akter/src/store/s3.ts"
import { Store, storeOf } from "../../../../packages/akter/src/store/service.ts"
import {
  Autumn,
  AutumnLive,
  Ledger,
  LedgerLive,
  Options,
  Request,
  SHARDS,
  Spring,
  SpringLive,
} from "./cluster.ts"

const nextDue = (image: {
  readonly timers: ReadonlyMap<string, { readonly timer: { readonly at: number } }>
  readonly jobs: ReadonlyMap<string, { readonly workflow: ReadonlyArray<Schema.Json> }>
}) => {
  let due: number | undefined
  for (const { timer } of image.timers.values())
    if (due === undefined || timer.at < due) due = timer.at
  for (const job of image.jobs.values())
    for (const at of pendingClocks(job.workflow)) if (due === undefined || at < due) due = at
  return due ?? null
}

/** Only fixture wall time is adjustable; elapsed time, sockets and every bucket operation remain real. */
const program = Effect.gen(function* () {
  const options = yield* Schema.decodeEffect(Schema.fromJsonString(Options))(
    yield* Config.String("AKTER_CLUSTER_OPTIONS"),
  )
  const real = yield* Clock.clockWith(Effect.succeed)
  let offset = options.at === undefined ? 0 : options.at - real.currentTimeMillisUnsafe()
  let changed = Latch.makeUnsafe()
  const time = () => real.currentTimeMillisUnsafe() + offset
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: time,
    currentTimeMillis: Effect.sync(time),
    currentTimeNanosUnsafe: () => BigInt(Math.trunc(time())) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(Math.trunc(time())) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: real.monotonicTimeNanos,
    sleep: (duration) =>
      Effect.gen(function* () {
        const end = time() + Duration.toMillis(duration)
        while (time() < end) {
          const wake = changed
          yield* Effect.raceFirst(real.sleep(Duration.millis(end - time())), wake.await)
        }
      }),
  }
  const useClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Clock.Clock, clock)
  const url = new URL(options.url)
  const bucket = yield* s3Bucket({
    endpoint: `${url.protocol}//${url.host}`,
    bucket: url.pathname.replace(/^\/+|\/+$/gu, ""),
    credentials: {
      accessKeyId: decodeURIComponent(url.username),
      secretAccessKey: decodeURIComponent(url.password),
    },
    prefix: options.prefix,
  })
  const rawStore = yield* storeOf(bucket, {
    shards: SHARDS,
    writer: options.writer,
    build: { bundle: options.bundle, framework: "0.2.0-process-evidence" },
  })
  const reading = new Map<number, number>()
  const replayMs = new Map<number, number>()
  const checkpointReady: Array<boolean> = []
  let explicitDrain = false
  let readiness = Effect.succeed(true)
  const store = Store.of({
    ...rawStore,
    read: (shard, ...args) => {
      if (!reading.has(shard)) reading.set(shard, performance.now())
      return rawStore.read(shard, ...args)
    },
    checkpoint: (lease, manifest) =>
      Effect.gen(function* () {
        if (explicitDrain) checkpointReady.push(yield* readiness)
        yield* rawStore.checkpoint(lease, manifest)
      }),
  })
  const implementations = yield* Layer.build(Layer.mergeAll(LedgerLive, SpringLive, AutumnLive))
  const catalog: Catalog = {
    actors: new Map([
      [
        Ledger.name,
        { actor: Ledger, registered: Context.get(implementations, Ledger.implementation) },
      ],
      [
        Spring.name,
        { actor: Spring, registered: Context.get(implementations, Spring.implementation) },
      ],
      [
        Autumn.name,
        { actor: Autumn, registered: Context.get(implementations, Autumn.implementation) },
      ],
    ]),
    shards: SHARDS,
  }
  const credentials = {
    ca: yield* Config.String("AKTER_CLUSTER_CA"),
    certificate: yield* Config.String("AKTER_CLUSTER_CERTIFICATE"),
    key: Redacted.make(yield* Config.String("AKTER_CLUSTER_KEY")),
  }
  const engine = yield* Engine.make(catalog, {
    shards: SHARDS,
    policy: "matching",
    maxBatch: 128,
    checkpointEvery: 0,
    cronSkipIfOlderThan: 3_600_000,
    doubleRun: false,
    observer: undefined,
  }).pipe(Effect.provideService(Store, store), useClock)
  let holdJobReply = false
  const journal = engine.journal
  engine.journal = (shard, entry) =>
    Effect.suspend(() => {
      if (
        holdJobReply &&
        Entry.guards.Step(entry) &&
        entry.name.startsWith("\u0000call\u0000credit")
      ) {
        holdJobReply = false
        return Effect.never
      }
      return journal(shard, entry)
    })
  const routing = yield* Routing.make(engine, {
    address: { host: "127.0.0.1", port: options.advertised },
    listenAddress: { host: "127.0.0.1", port: options.listen },
    peering: { deployment: options.deployment, credentials: Effect.succeed(credentials) },
    shardLockExpiration: options.short ? "3 seconds" : undefined,
    refreshAssignmentsInterval: options.short ? "100 millis" : undefined,
    shardLockRefreshInterval: options.short ? "1 second" : undefined,
  }).pipe(Effect.provideService(Store, store), useClock)
  readiness = Effect.map(routing.readiness, (status) => status.ready)
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        for (let shard = 0; shard < SHARDS; shard++) {
          const began = reading.get(shard)
          if (began !== undefined && !replayMs.has(shard) && engine.status(shard).status === "open")
            replayMs.set(shard, performance.now() - began)
        }
        yield* real.sleep(Duration.millis(2))
      }),
    ),
  )
  const caller = user("process-evidence")
  const actorOf = (name: string) => {
    const actor = catalog.actors.get(name)?.actor
    if (actor === undefined) throw new Error("Unknown fixture actor")
    return actor
  }
  const drainNow = Effect.gen(function* () {
    explicitDrain = true
    const report = yield* routing.drain("15 seconds")
    return { ...report, checkpointReady }
  })
  yield* Effect.forkScoped(
    RuntimeControl.waitForSignal({ deadline: "15 seconds" }).pipe(
      Effect.provideService(RuntimeControl, {
        readiness: routing.readiness,
        drain: () => drainNow,
      }),
      useClock,
    ),
  )
  const dispatch = (request: typeof Request.Type) =>
    Request.match(request, {
      Status: () =>
        Effect.map(routing.readiness, (ready) => ({
          ...ready,
          pid: process.pid,
          now: time(),
          checkpointReady,
          shards: Array.from({ length: SHARDS }, (_, id) => {
            const image = engine.durableImage(id)
            return {
              id,
              ...engine.status(id),
              refusal: engine.shards().find((shard) => shard.id === id)?.refusal?._tag,
              nextDue: image === undefined ? null : nextDue(image),
              replayMs: replayMs.get(id) ?? null,
            }
          }),
        })),
      Mint: () => Effect.map(CommandIds.mint(time()), (commandId) => ({ commandId })),
      Call: (call) =>
        routing.admitted(caller, call.commandId, {
          actor: actorOf(call.actor),
          id: call.key,
          member: call.member,
          payload: call.payload,
        }),
      State: (read) =>
        Effect.map(
          Stream.runHead(routing.reads(caller).state({ actor: actorOf(read.actor), id: read.key })),
          (frame) =>
            Option.isSome(frame) && frame.value.kind === "Frame" ? frame.value.value : {},
        ),
      Drain: () => drainNow,
      HoldJobReply: () =>
        Effect.sync(() => {
          holdJobReply = true
          return { held: true }
        }),
      Clock: ({ at }) =>
        Effect.sync(() => {
          offset = at - real.currentTimeMillisUnsafe()
          const previous = changed
          changed = Latch.makeUnsafe()
          previous.openUnsafe()
          return { now: time() }
        }),
      Bulk: ({ key, count }) =>
        Effect.gen(function* () {
          const began = performance.now()
          const ids = yield* Effect.forEach(
            Array.from({ length: count }, (_, index) => index),
            (index) =>
              Effect.flatMap(CommandIds.mint(time()), (commandId) =>
                routing
                  .admitted(caller, commandId, {
                    actor: Ledger,
                    id: key,
                    member: "add",
                    payload: index % 2 === 0 ? 3 : 7,
                  })
                  .pipe(Effect.as(commandId)),
              ),
            { concurrency: 256 },
          )
          return {
            count,
            elapsedMs: performance.now() - began,
            lastId: ids[count - 1]!,
            lastAmount: (count - 1) % 2 === 0 ? 3 : 7,
          }
        }),
    })
  const { createServer } = yield* Effect.promise(() => import("node:http"))
  const runRequest = Effect.runPromiseWith(yield* Effect.context<never>())
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      createServer((incoming, response) => {
        let body = ""
        incoming.setEncoding("utf8")
        incoming.on("data", (chunk: string) => {
          body += chunk
        })
        incoming.on("end", () => {
          const decoded = Schema.decodeResult(Schema.fromJsonString(Request))(body)
          if (Result.isFailure(decoded)) {
            response.writeHead(400).end()
            return
          }
          const request = decoded.success
          void runRequest(dispatch(request).pipe(useClock, Effect.result))
            .then((result) => {
              if (
                Request.guards.Call(request) &&
                request.drop === true &&
                Result.isSuccess(result)
              ) {
                incoming.socket.destroy()
                return
              }
              response
                .writeHead(Result.isSuccess(result) ? 200 : 503, {
                  "content-type": "application/json",
                })
                .end(
                  JSON.stringify(Result.isSuccess(result) ? result.success : { retryable: true }),
                )
            })
            .catch(() => {
              response.writeHead(500).end(JSON.stringify({ defect: true }))
            })
        })
      }),
    ),
    (opened) =>
      Effect.sync(() => {
        opened.closeAllConnections()
        opened.close()
      }),
  )
  const port = yield* Effect.callback<number>((resume) => {
    server.listen(0, "127.0.0.1", () => {
      const parsed = Schema.decodeUnknownResult(Schema.Struct({ port: Schema.Int }))(
        server.address(),
      )
      resume(
        Result.isSuccess(parsed)
          ? Effect.succeed(parsed.success.port)
          : Effect.die(new Error("No control port")),
      )
    })
  })
  yield* Console.log(`CONTROL ${port}`)
  return yield* Effect.never
})

await Effect.runPromise(
  Effect.scoped(program).pipe(
    Effect.catchCause(() =>
      Effect.andThen(
        Console.error("Cluster fixture failed"),
        Effect.sync(() => {
          process.exitCode = 1
        }),
      ),
    ),
  ),
)
