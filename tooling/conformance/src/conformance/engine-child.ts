import { Config, Console, Effect, Layer, Predicate } from "effect"
import { fileSystemBucket } from "../../../../packages/akter/src/store/file-system.ts"
import { s3Bucket } from "../../../../packages/akter/src/store/s3.ts"
import { add, assignAll, mint, runner } from "./engine-runner.ts"

const platform =
  globalThis.Bun === undefined
    ? (await import("@effect/platform-node")).NodeServices.layer
    : (await import("@effect/platform-bun")).BunServices.layer

const bucket = Effect.gen(function* () {
  const directory = yield* Config.String("AKTER_CONFORMANCE_DIRECTORY").pipe(Config.withDefault(""))
  if (directory !== "") {
    const services = yield* Layer.build(platform)
    return yield* fileSystemBucket(directory).pipe(Effect.provide(services))
  }
  const url = new URL(yield* Config.String("AKTER_CONFORMANCE_S3_URL"))
  return yield* s3Bucket({
    endpoint: `${url.protocol}//${url.host}`,
    bucket: url.pathname.replace(/^\/+|\/+$/gu, ""),
    credentials: {
      accessKeyId: decodeURIComponent(url.username),
      secretAccessKey: decodeURIComponent(url.password),
    },
    prefix: yield* Config.String("AKTER_CONFORMANCE_S3_PREFIX"),
  })
})

/**
 * An owner process for the SIGKILL scenario: it opens every shard of the location its parent names
 * (`AKTER_CONFORMANCE_DIRECTORY`, or `AKTER_CONFORMANCE_S3_URL` and `AKTER_CONFORMANCE_S3_PREFIX`)
 * and adds to tallies one call at a time until it is killed, printing each id before it is sent
 * and each reply once it arrives, so the parent knows what was acknowledged and what may be.
 */
const program = Effect.gen(function* () {
  const { engine } = yield* runner(yield* bucket, { writer: "child" })
  yield* assignAll(engine)
  yield* Console.log("ready")
  for (let call = 0; ; call++) {
    const commandId = yield* mint
    yield* Console.log(`sent ${call} ${commandId}`)
    const reply = yield* add(engine, commandId, `k${call % 4}`, call + 1)
    if (reply.kind !== "Success" || !Predicate.isNumber(reply.value))
      return yield* Effect.die(new Error("the add failed"))
    yield* Console.log(`ack ${call} ${reply.value}`)
  }
})

await Effect.runPromise(Effect.scoped(program))
