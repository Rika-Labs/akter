import { readFileSync } from "node:fs"
import { BunClusterSocket, BunCrypto, BunHttpServer, BunServices } from "@effect/platform-bun"
import { Actor } from "@rikalabs/akter"
import { Actors, Auth, ColdStorage, Database, Metrics, Runner } from "@rikalabs/akter/runtime"
import { Cause, Clock, Effect, Exit, Layer, Metric, Redacted, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { TurnPoolSettings } from "../../../packages/akter/src/runtime/turn/pipeline.ts"
import { measuredStream, wire } from "./wire.ts"

const operation = process.env.OPERATION
const sleepy = operation === "idle" || operation === "cold"
const Increment = Actor.command("Increment", {
  payload: Schema.Struct({ by: Schema.Int }),
  success: Schema.Int,
})
const Read = Actor.query("Read", { success: Schema.Int })
const Counter = Actor.make("BenchCounter", {
  key: Schema.String,
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Increment, Read },
  access: Actor.access.public,
  policy: {
    hibernateAfter: sleepy ? "250 millis" : "1 hour",
    coldAfter: operation === "cold" ? "250 millis" : "never",
  },
})

const handlers = Layer.merge(
  Counter.toLayer({
    Increment: Effect.fnUntraced(function* ({ by }) {
      const turn = yield* Counter.Turn
      yield* turn.state.set({ count: turn.state.count + by })
      return turn.state.count
    }),
  }),
  Counter.toQueryLayer({
    Read: Effect.fnUntraced(function* () {
      const read = yield* Counter.Read
      return read.state.count
    }),
  }),
)

const snapshot = Effect.gen(function* () {
  const resident = yield* Metric.value(
    Metric.withAttributes(Metrics.activations, { actor_type: "BenchCounter" }),
  )
  return {
    at: performance.now(),
    wall: yield* Clock.currentTimeMillis,
    cpu: process.cpuUsage(),
    mainTicks: readFileSync(`/proc/self/task/${process.pid}/stat`, "utf8")
      .split(") ")[1]!
      .split(" ")
      .slice(11, 13)
      .reduce((sum, value) => sum + Number(value), 0),
    rss: process.memoryUsage().rss,
    resident: resident.value,
    flights: wire.flights,
    statements: wire.statements,
    bun: Bun.version,
  }
})

const controls = Layer.mergeAll(
  HttpRouter.add("POST", "/measure", snapshot.pipe(Effect.map(HttpServerResponse.jsonUnsafe))),
  HttpRouter.add(
    "POST",
    "/gc",
    Effect.sync(() => Bun.gc(true)).pipe(
      Effect.andThen(snapshot),
      Effect.map(HttpServerResponse.jsonUnsafe),
    ),
  ),
  HttpRouter.add(
    "POST",
    "/exit",
    Effect.sync(() => {
      Effect.runFork(Effect.sleep(100).pipe(Effect.andThen(Effect.sync(() => process.exit(0)))))
      return HttpServerResponse.empty()
    }),
  ),
)

const database = Database.postgres({ url: Redacted.make(process.env.DATABASE_URL!) })
const runner = Runner.socket({
  address: { host: "runner", port: 9000 },
  listenAddress: { host: "0.0.0.0", port: 9000 },
  transport: Layer.merge(BunClusterSocket.layerSocketServer, BunClusterSocket.layerClientProtocol),
})
const live = handlers.pipe(
  Layer.provideMerge(
    Actors.layer({
      maxResidentActors: 20_000,
      coldStorage:
        operation === "cold"
          ? { store: ColdStorage.memory(), backupRetention: "1 day" }
          : undefined,
    }).pipe(Layer.provide(runner)),
  ),
  Layer.provideMerge(database),
)
const serving = HttpRouter.serve(
  Layer.merge(controls, Actors.serve({ actors: [Counter], auth: Auth.none })),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provide(live),
  Layer.provide(
    Layer.mergeAll(
      BunCrypto.layer,
      BunServices.layer,
      BunHttpServer.layer({ hostname: "0.0.0.0", port: 8080 }),
    ),
  ),
)

const program = Layer.launch(serving)
const exit = await Effect.runPromiseExit(
  process.env.DIAGNOSTIC === "1"
    ? program.pipe(Effect.provideService(TurnPoolSettings, { stream: measuredStream }))
    : program,
)
if (Exit.isFailure(exit)) {
  console.error(Cause.pretty(exit.cause))
  process.exitCode = 1
}
