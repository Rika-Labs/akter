import { stdin } from "node:process"
import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { layerClientProtocol, layerSocketServer } from "@effect/platform-bun/BunClusterSocket"
import { Clock, Config, Console, Effect, Layer, Option, Redacted, Schedule, Schema } from "effect"
import { RunnerAddress, RunnerServer } from "effect/unstable/cluster"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { Actor, Actors as ActorClient } from "../../../../index.ts"
import { Actors, Database } from "../../../../runtime/index.ts"
import { RunnerWiring } from "../../../../runtime/layer.ts"
import { TurnHooks } from "../../../../runtime/turn/hooks.ts"

const Increment = Actor.command("Increment", { input: Schema.Int })

const Add = Actor.command("Add", { input: Schema.Int })

const Send = Actor.command("Send", { input: Schema.String })

const count = Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) })

const Counter = Actor.make("DrillCounter", { key: Schema.String, state: count, api: { Increment } })

const Receiver = Actor.make("DrillReceiver", {
  key: Schema.String,
  state: count,
  api: {},
  internal: { Add },
})

const Sender = Actor.make("DrillSender", { key: Schema.String, api: { Send } })

const bump = Effect.fnUntraced(function* (amount: number) {
  const turn = yield* Counter.Turn
  yield* turn.state.set({ count: turn.state.count + amount })
})

const live = Layer.mergeAll(
  Counter.toLayer(Effect.succeed({ Increment: bump })),
  Receiver.toLayer(
    Effect.succeed({
      Add: Effect.fnUntraced(function* (amount: number) {
        const turn = yield* Receiver.Turn
        yield* turn.state.set({ count: turn.state.count + amount })
      }),
    }),
  ),
  Sender.toLayer(
    Effect.succeed({
      Send: Effect.fnUntraced(function* (to: string) {
        yield* (yield* Receiver.intents(to)).Add(1)
      }),
    }),
  ),
)

/** Lock expiry, and so the longest a dead runner's shards stay out of reach. */
const SHARD_LOCK = "3 seconds"

const runtime = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* Config.String("DRILL_DATABASE_URL")
    const port = yield* Config.Int("DRILL_PORT")
    const blockRelay = yield* Config.Boolean("DRILL_BLOCK_RELAY").pipe(Config.withDefault(false))
    const address = RunnerAddress.RunnerAddress.make({ host: "127.0.0.1", port })
    let blocked = false

    // A relay told to block stops at its first claim once the parent asks, holding what it claimed.
    const hooks = Layer.succeed(TurnHooks, {
      at: (point) =>
        blockRelay && point === "afterClaim" && !blocked
          ? Effect.suspend(() => {
              blocked = true

              return Console.log("CLAIMED").pipe(Effect.andThen(Effect.never))
            })
          : Effect.void,
    })

    const sharding = RunnerServer.layerWithClients.pipe(
      Layer.provide(RpcServer.layerProtocolSocketServer),
      Layer.provide(layerSocketServer),
      Layer.provide(layerClientProtocol),
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.orDie,
    )

    const wiring = Layer.succeed(RunnerWiring, {
      config: {
        runnerAddress: Option.some(address),
        shardsPerGroup: 32,
        shardLockExpiration: SHARD_LOCK,
        shardLockDisableAdvisory: true,
        refreshAssignmentsInterval: "250 millis",
        sendRetryInterval: "50 millis",
        entityTerminationTimeout: "2 seconds",
      },
      sharding,
      storage: (storage) => storage,
    })

    return live.pipe(
      Layer.provideMerge(
        Actors.layer({
          authorize: () => Effect.succeed(true),
          relay: { poll: "200 millis", claimLease: "5 seconds" },
        }).pipe(Layer.provide(Layer.mergeAll(hooks, wiring))),
      ),
      Layer.provideMerge(Database.postgres({ url: Redacted.make(database) })),
    )
  }),
).pipe(Layer.provideMerge(BunCrypto.layer))

// The parent paces each runner with named lines on stdin: GO starts its
// load, RESUME releases a runner held mid-load. A closed stdin releases every
// wait, so a runner whose parent died never hangs.
const received = new Set<string>()

const waiting = new Map<string, () => void>()

let ended = false

let pending = ""

stdin.on("data", (chunk: Buffer) => {
  const lines = (pending + chunk.toString()).split("\n")
  pending = lines.pop()!

  for (const line of lines) {
    received.add(line)
    waiting.get(line)?.()
  }
})

stdin.once("end", () => {
  ended = true

  for (const release of waiting.values()) release()
})

const signal = (line: string) =>
  Effect.callback<void>((resume) => {
    if (ended || received.has(line)) resume(Effect.void)
    else waiting.set(line, () => resume(Effect.void))
  })

// Each runner is also a caller: it retries a command under its minted id until
// it commits, as a client would, and reports each commit and its latency.
const program = Effect.gen(function* () {
  const actors = yield* ActorClient
  const operations = yield* Config.Int("DRILL_OPERATIONS")
  const holdAt = yield* Config.Int("DRILL_HOLD_AT").pipe(Config.withDefault(operations))
  yield* Console.log("READY")
  yield* signal("GO")

  for (let index = 0; index < operations; index++) {
    if (index === holdAt) yield* signal("RESUME")

    const started = yield* Clock.currentTimeMillis
    const incrementId = yield* actors.mintCommandId
    const sendId = yield* actors.mintCommandId
    const counter = yield* Counter.get(`counter-${index % 48}`)
    const sender = yield* Sender.get(`sender-${index % 24}`)

    yield* counter
      .Increment(1)
      .pipe(
        Actor.commandId(incrementId),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 600 }),
        Effect.orDie,
      )

    yield* sender
      .Send(`receiver-${index % 32}`)
      .pipe(
        Actor.commandId(sendId),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 600 }),
        Effect.orDie,
      )

    const latency = (yield* Clock.currentTimeMillis) - started
    yield* Console.log(`DONE ${index} ${started} ${latency} ${incrementId} ${sendId}`)
  }

  yield* Console.log("FINISHED")

  return yield* Effect.never
})

Layer.effectDiscard(program).pipe(
  Layer.provide(runtime),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
