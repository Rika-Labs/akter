import { stdin } from "node:process"
import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { layerClientProtocol, layerSocketServer } from "@effect/platform-bun/BunClusterSocket"
import { Clock, Config, Console, Effect, Layer, Redacted, Schedule, Schema } from "effect"
import { InternalActors } from "../../../../runtime/actors.ts"
import { Actor, Actors as ActorClient } from "../../../../index.ts"
import { Actors, Database, Runner, RuntimeControl } from "../../../../runtime/index.ts"
import { TurnHooks } from "../../../../runtime/turn/hooks.ts"

const Increment = Actor.command("Increment", { payload: Schema.Int })

const Add = Actor.command("Add", { payload: Schema.Int })

const Send = Actor.command("Send", { payload: Schema.String })

const count = Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) })

const Counter = Actor.make("DrillCounter", { key: Schema.String, state: count, api: { Increment } })

const Receiver = Actor.make("DrillReceiver", {
  key: Schema.String,
  state: count,
  api: {},
  internal: { Add },
})

const Sender = Actor.make("DrillSender", { key: Schema.String, api: { Send } })

const Pulse = Actor.command("Pulse")
const Loop = Actor.command("Loop", { payload: Schema.Int })
const Pulsed = Actor.event("Pulsed", { by: Schema.Int, source: Schema.String })

const Beacon = Actor.make("DrillBeacon", {
  key: Actor.singleton,
  state: count,
  api: { Loop },
  internal: { Pulse },
  events: [Pulsed],
  schedules: { "@every 1 second": Pulse },
})

const beacon = Beacon.toLayer(
  Effect.gen(function* () {
    const port = yield* Config.Int("DRILL_PORT")
    const handle = yield* Beacon.get()
    yield* handle
      .Loop(port)
      .pipe(Effect.ignore, Effect.repeat(Schedule.spaced("250 millis")), Effect.forkScoped)

    const record = Effect.fnUntraced(function* (source: string) {
      const turn = yield* Beacon.Turn
      yield* turn.state.set({ count: turn.state.count + 1 })
      yield* turn.emit(Pulsed.make({ by: port, source }))
    })

    return {
      Pulse: () => record("cron"),
      Loop: (from: number) => record(`loop:${from}`),
    }
  }),
)

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
    const shards = yield* Config.Int("DRILL_SHARDS").pipe(Config.withDefault(32))
    const blockRelay = yield* Config.Boolean("DRILL_BLOCK_RELAY").pipe(Config.withDefault(false))
    const blockCron = yield* Config.Boolean("DRILL_BLOCK_CRON").pipe(Config.withDefault(false))
    const background = yield* Config.Boolean("DRILL_BACKGROUND").pipe(Config.withDefault(false))
    let blocked = false

    const hooks = Layer.succeed(TurnHooks, {
      at: (point, request) =>
        blockCron && point === "beforeOutboxDelete" && request?.command === "Pulse"
          ? Console.log(`CRON_COMMITTED ${request.commandId}`).pipe(Effect.andThen(Effect.never))
          : blockRelay && point === "afterClaim" && !blocked
            ? Effect.suspend(() => {
                blocked = true

                return Console.log("CLAIMED").pipe(Effect.andThen(Effect.never))
              })
            : Effect.void,
    })

    const wiring = Runner.socket({
      address: { host: "127.0.0.1", port },
      listenAddress: { host: "0.0.0.0", port },
      transport: Layer.merge(layerSocketServer, layerClientProtocol),
      shardsPerGroup: shards,
      shardLockExpiration: SHARD_LOCK,
      refreshAssignmentsInterval: "250 millis",
      entityTerminationTimeout: "2 seconds",
    })

    return Layer.merge(live, background ? beacon : Layer.empty).pipe(
      Layer.provideMerge(
        Actors.layer({
          relay: { poll: "200 millis", claimLease: "5 seconds" },
        }).pipe(Layer.provide(Layer.mergeAll(hooks, wiring))),
      ),
      Layer.provideMerge(Database.postgres({ url: Redacted.make(database) })),
    )
  }),
).pipe(Layer.provideMerge(BunCrypto.layer))

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

const signal = (line: string, onEnd = true) =>
  Effect.callback<void>((resume) => {
    const release = () => {
      if ((ended && onEnd) || received.has(line)) resume(Effect.void)
    }
    release()
    waiting.set(line, release)
  })

const program = Effect.gen(function* () {
  const actors = yield* ActorClient
  const internal = yield* InternalActors
  const control = yield* RuntimeControl
  const operations = yield* Config.Int("DRILL_OPERATIONS")
  const holdAt = yield* Config.Int("DRILL_HOLD_AT").pipe(Config.withDefault(operations))

  const mint = actors.mintCommandId.pipe(
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 600 }),
    Effect.orDie,
  )

  yield* control.readiness.pipe(
    Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: ({ ready }) => ready }),
    Effect.timeout("30 seconds"),
    Effect.orDie,
  )
  yield* Console.log("READY")
  yield* signal("DRAIN", false).pipe(
    Effect.andThen(control.drain({ deadline: "5 seconds" })),
    Effect.tap((report) => Console.log(`DRAINED ${JSON.stringify(report)}`)),
    Effect.andThen(control.readiness),
    Effect.tap((readiness) => Console.log(`READINESS ${JSON.stringify(readiness)}`)),
    Effect.andThen(signal("EXIT", false)),
    Effect.andThen(Effect.sync(() => process.kill(process.pid, "SIGTERM"))),
    Effect.forkScoped,
  )
  yield* signal("GO")

  for (let index = 0; index < operations; index++) {
    if (index === holdAt) yield* signal("RESUME")

    const started = yield* Clock.currentTimeMillis
    const incrementId = yield* mint
    const sendId = yield* mint
    const counter = yield* Counter.get(`counter-${index % 48}`)
    const sender = yield* Sender.get(`sender-${index % 24}`)

    yield* counter
      .Increment(1)
      .pipe(
        Actor.commandId(incrementId),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 600 }),
        Effect.orDie,
      )
    yield* Console.log(`ACKED ${incrementId}`)

    yield* sender
      .Send(`receiver-${index % 32}`)
      .pipe(
        Actor.commandId(sendId),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 600 }),
        Effect.orDie,
      )
    yield* Console.log(`ACKED ${sendId}`)

    const latency = (yield* Clock.currentTimeMillis) - started
    const counterShard = yield* internal.shardId(counter.ref)
    const senderShard = yield* internal.shardId(sender.ref)
    yield* Console.log(
      `DONE ${index} ${started} ${latency} ${incrementId} ${sendId} ${counterShard} ${senderShard}`,
    )
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
