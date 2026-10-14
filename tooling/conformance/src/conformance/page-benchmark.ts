import {
  Config,
  Console,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Random,
  Schema,
  Scope,
} from "effect"
import { fileSystemBucket } from "../../../../packages/akter/src/store/file-system.ts"
import { s3Bucket } from "../../../../packages/akter/src/store/s3.ts"
import { Library, pageRunner } from "./page-runner.ts"

const quantile = (values: ReadonlyArray<number>, fraction: number): number => {
  const sorted = Array.from(values).sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!
}

const platform =
  globalThis.Bun === undefined
    ? (await import("@effect/platform-node")).NodeServices.layer
    : (await import("@effect/platform-bun")).BunServices.layer

await Effect.gen(function* () {
  const machine = yield* Config.String("BENCH_MACHINE")
  const provider = yield* Config.String("BENCH_PROVIDER")
  const adapter = yield* Config.String("BENCH_ADAPTER").pipe(Config.withDefault("fileSystem"))
  const services = yield* Layer.build(platform)
  const fs = Context.get(services, FileSystem.FileSystem)
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "akter-page-bench-" })
  const location =
    adapter === "fileSystem"
      ? fileSystemBucket(directory).pipe(Effect.provideContext(services))
      : Effect.gen(function* () {
          const url = new URL(yield* Config.String("TEST_S3_URL"))
          return yield* s3Bucket({
            bucket: url.pathname.slice(1),
            endpoint: `${url.protocol}//${url.host}`,
            credentials: {
              accessKeyId: decodeURIComponent(url.username),
              secretAccessKey: decodeURIComponent(url.password),
            },
            prefix: `page-benchmark/${yield* Random.nextIntBetween(0, 0xffff_ffff)}/`,
          })
        })
  const bucket = yield* location
  const count = 9000
  const first = yield* pageRunner(bucket, {
    writer: "benchmark-snapshot",
    checkpointEvery: 0,
    doubleRun: false,
  })
  yield* first.call("source", "fill", count)
  if ((yield* first.engine.drain("1 minute")).outcome !== "clean")
    throw new Error("Snapshot drain failed")
  const tailScope = yield* Scope.make()
  const tail = yield* Scope.provide(tailScope)(
    pageRunner(bucket, { writer: "benchmark-tail", checkpointEvery: 0, doubleRun: false }),
  )
  for (let id = 0; id < 100; id++) yield* tail.call("source", "change", id)
  yield* Scope.close(tailScope, Exit.void)
  const wakes: Array<number> = []
  for (let sample = 0; sample < 20; sample++) {
    const scope = yield* Scope.make()
    const start = performance.now()
    const cold = yield* Scope.provide(scope)(
      pageRunner(bucket, {
        writer: `benchmark-wake-${sample}`,
        checkpointEvery: 0,
        doubleRun: false,
      }),
    )
    const record = yield* cold.engine.durableRecord(Library, "source")
    if (record.image.state.count !== count + 100) throw new Error("Cold wake lost a tail action")
    const window = yield* cold.range("source", 7000, 7001, 1)
    if (window.length !== 1 || !Schema.is(Schema.Struct({ id: Schema.Literal(2000) }))(window[0]))
      throw new Error("Cold range returned the wrong row")
    wakes.push(performance.now() - start)
    yield* Scope.close(scope, Exit.void)
  }
  const current = yield* pageRunner(bucket, {
    writer: "benchmark-misses",
    checkpointEvery: 0,
    doubleRun: false,
  })
  yield* current.engine.durableRecord(Library, "source")
  const misses: Array<number> = []
  for (let sample = 0; sample < 100; sample++) {
    current.engine.pages.clear()
    const start = performance.now()
    const window = yield* current.range("source", 7000, 7001, 1)
    if (window.length !== 1 || !Schema.is(Schema.Struct({ id: Schema.Literal(2000) }))(window[0]))
      throw new Error("Page miss returned the wrong row")
    misses.push(performance.now() - start)
  }
  yield* Console.log(
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      machine,
      provider,
      adapter,
      runtime: globalThis.Bun === undefined ? "Node" : "Bun",
      runtimeVersion: globalThis.Bun === undefined ? process.version : globalThis.Bun.version,
      platform: process.platform,
      arch: process.arch,
      items: count,
      minimumPayloadBytes: count * 1100,
      tailActionEntries: 100,
      cacheBytes: 72000,
      coldWake: {
        samples: wakes.length,
        p50Ms: quantile(wakes, 0.5),
        p99Ms: quantile(wakes, 0.99),
      },
      pageMiss: {
        samples: misses.length,
        p50Ms: quantile(misses, 0.5),
        p99Ms: quantile(misses, 0.99),
      },
      errors: 0,
      establishes50GB: false,
    }),
  )
}).pipe(
  Effect.catchCause(() =>
    Effect.andThen(
      Console.error("Page benchmark failed; no measurement is claimed."),
      Effect.sync(() => {
        process.exitCode = 1
      }),
    ),
  ),
  Effect.scoped,
  Effect.runPromise,
)
