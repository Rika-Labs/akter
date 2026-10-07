import { Config, Console, Effect, FileSystem, Layer, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import { Counter } from "./contract.ts"

const CommandId = Schema.Struct({ commandId: Schema.String })
const Ready = Schema.Struct({ ready: Schema.Boolean, reason: Schema.optional(Schema.String) })

const check = Effect.gen(function* () {
  const mode = yield* Config.String("CHECK_MODE").pipe(Config.withDefault("basic"))
  const fs = yield* FileSystem.FileSystem
  const token = (yield* fs.readFileString("/run/secrets/api-token")).trim()
  const headers = { authorization: `Bearer ${token}` }
  const first = Counter.client({ baseUrl: "http://runner-a:8080", headers }).get("visits")
  const second = Counter.client({ baseUrl: "http://runner-b:8080", headers }).get("visits")
  const call = <A>(run: () => Promise<A>) => Effect.tryPromise(run)

  if (mode === "basic") {
    const denied = yield* HttpClient.post("http://runner-a:8080/actors/Counter/visits/Increment")
    if (denied.status !== 401)
      return yield* Effect.die(new Error(`Unauthenticated command returned ${denied.status}`))
    const wrongToken = yield* HttpClient.post(
      "http://runner-b:8080/actors/Counter/visits/Increment",
      {
        headers: { authorization: "Bearer invalid-token" },
      },
    )
    if (wrongToken.status !== 401)
      return yield* Effect.die(new Error(`Wrong-token command returned ${wrongToken.status}`))
    if ((yield* call(() => first.Increment(3))) !== 3)
      return yield* Effect.die(new Error("First increment did not commit 3"))
    if ((yield* call(() => second.Increment(7))) !== 10)
      return yield* Effect.die(new Error("Second runner did not commit 10"))
    if (
      (yield* call(() => first.GetCount())) !== 10 ||
      (yield* call(() => second.GetCount())) !== 10
    )
      return yield* Effect.die(new Error("Both runners must read 10"))
    yield* Console.log(
      "BASIC_OK both runners committed and read 10; missing and wrong credentials denied",
    )
    return
  }

  if (mode === "hold" || mode === "stack") {
    const host = yield* Config.String("CHECK_HOST")
    const target = Counter.client({ baseUrl: `http://${host}:8080`, headers }).get("visits")
    const response = yield* HttpClient.post(`http://${host}:8080/command-ids`, { headers })
    if (response.status !== 200)
      return yield* Effect.die(new Error(`Command-id mint failed: ${response.status}`))
    const id = yield* HttpClientResponse.schemaBodyJson(CommandId)(response)
    yield* fs.writeFileString("/tmp/self-host-command-id", id.commandId)
    const readiness = HttpClient.get(`http://${host}:8080/ready`).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Ready)),
      Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: (ready) => !ready.ready }),
      Effect.timeout("8 seconds"),
      Effect.flatMap((ready) =>
        ready.reason === "draining"
          ? Console.log("UNREADY_OK active runner reported draining before command completed")
          : Effect.die(new Error(`Expected draining readiness, received ${ready.reason}`)),
      ),
    )
    const amount = mode === "hold" ? 11 : 13
    const expected = mode === "hold" ? 21 : 34
    const [value] = yield* Effect.all(
      [
        call(() => target.Increment(amount, { commandId: id.commandId })),
        mode === "hold" ? readiness : Effect.void,
      ],
      { concurrency: "unbounded" },
    )
    if (value !== expected)
      return yield* Effect.die(
        new Error(`In-flight command returned ${value}, expected ${expected}`),
      )
    yield* Console.log(
      mode === "hold"
        ? "HOLD_OK in-flight command committed 21"
        : "STACK_OK command survived full Compose stop and restart, count 34",
    )
    return
  }

  if (mode === "replay" || mode === "stack-replay") {
    const commandId = yield* Config.String("CHECK_COMMAND_ID")
    const expected = mode === "replay" ? 21 : 34
    const replay = yield* call(() => second.Increment(mode === "replay" ? 11 : 13, { commandId }))
    const count = yield* call(() => first.GetCount())
    if (replay !== expected || count !== expected)
      return yield* Effect.die(
        new Error(
          `Receipt replay duplicated or lost the increment: replay=${replay}, count=${count}`,
        ),
      )
    yield* Console.log(`REPLAY_OK durable receipt returned ${expected} without another increment`)
    return
  }

  return yield* Effect.die(new Error(`Unknown CHECK_MODE ${mode}`))
})

const services =
  typeof Bun === "undefined"
    ? (await import("@effect/platform-node")).NodeServices.layer
    : (await import("@effect/platform-bun")).BunServices.layer

await Effect.runPromise(check.pipe(Effect.provide(Layer.merge(services, FetchHttpClient.layer))))
