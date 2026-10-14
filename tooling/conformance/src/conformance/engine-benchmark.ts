import { hostname } from "node:os"
import {
  Config,
  Console,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Random,
  Result,
  Schema,
} from "effect"
import { fileSystemBucket } from "../../../../packages/akter/src/store/file-system.ts"
import { s3Bucket } from "../../../../packages/akter/src/store/s3.ts"
import type { Bucket } from "../../../../packages/akter/src/store/bucket.ts"
import { add, assignAll, mint, runner, SHARDS, total } from "./engine-runner.ts"

interface Sample {
  readonly name: string
  readonly actions: number
  readonly failures: number
  readonly elapsedMs: number
  readonly throughput: number
  readonly p50Ms: number
  readonly p99Ms: number
  readonly logPuts: number
  readonly logPutP50Ms: number
  readonly logPutP99Ms: number
  readonly segmentP50Bytes: number
  readonly segmentP99Bytes: number
  readonly actionsPerPut: number
  readonly pagePuts: number
}

const quantile = (values: ReadonlyArray<number>, fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

const actionSample = (
  bucket: Bucket,
  name: string,
  actors: number,
  durationMs: number,
  concurrency: number,
  checkpointEvery: number,
  maxBatch: number,
  diagnostics: boolean,
  drainBudgetMs: number,
) =>
  Effect.gen(function* () {
    const puts: Array<number> = []
    const sizes: Array<number> = []
    let pages = 0
    let measuring = false
    const opened = yield* runner(
      {
        ...bucket,
        create: (key, bytes) =>
          /\/log\//u.test(key)
            ? Effect.suspend(() => {
                const before = performance.now()
                const measured = measuring
                return bucket.create(key, bytes).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      if (measured) {
                        puts.push(performance.now() - before)
                        sizes.push(bytes.length)
                      }
                    }),
                  ),
                )
              })
            : bucket.create(key, bytes),
        put: (key, bytes) => {
          if (measuring) pages++
          return bucket.put(key, bytes)
        },
      },
      { writer: name, checkpointEvery, maxBatch },
    )
    yield* assignAll(opened.engine)
    yield* Effect.forEach(
      Array.from({ length: Math.max(actors, 256) }, (_, key) => key),
      (key) => Effect.flatMap(mint, (id) => add(opened.engine, id, `k${key % actors}`, 0)),
      { concurrency: concurrency, discard: true },
    )
    const expected = Array.from({ length: actors }, () => 0)
    const latencies: Array<number> = []
    let actions = 0
    let failures = 0
    const started = performance.now()
    const deadline = started + durationMs
    measuring = true
    yield* Effect.forEach(
      Array.from({ length: concurrency }, (_, worker) => worker),
      (worker) =>
        Effect.gen(function* () {
          let ordinal = worker
          while (performance.now() < deadline) {
            const key = `k${ordinal % actors}`
            const id = yield* mint
            const before = performance.now()
            const result = yield* Effect.result(add(opened.engine, id, key, 1))
            latencies.push(performance.now() - before)
            if (Result.isSuccess(result) && result.success.kind === "Success") {
              actions += 1
              expected[ordinal % actors] = (expected[ordinal % actors] ?? 0) + 1
            } else failures += 1
            ordinal += concurrency
          }
        }),
      { concurrency: "unbounded", discard: true },
    )
    const elapsedMs = performance.now() - started
    measuring = false
    const sample = {
      name,
      actions,
      failures,
      elapsedMs,
      throughput: actions / (elapsedMs / 1_000),
      p50Ms: quantile(latencies, 0.5),
      p99Ms: quantile(latencies, 0.99),
      logPuts: puts.length,
      logPutP50Ms: quantile(puts, 0.5),
      logPutP99Ms: quantile(puts, 0.99),
      segmentP50Bytes: quantile(sizes, 0.5),
      segmentP99Bytes: quantile(sizes, 0.99),
      actionsPerPut: actions / puts.length,
      pagePuts: pages,
    } satisfies Sample
    if (diagnostics)
      yield* Console.log(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          phase: "measured",
          ...sample,
        }),
      )
    const drainStarted = performance.now()
    const drained = yield* opened.engine.drain(Duration.millis(drainBudgetMs))
    const drainMs = performance.now() - drainStarted
    if (drained.outcome !== "clean")
      return yield* Effect.die(new Error("benchmark drain timed out"))
    const recoveryStarted = performance.now()
    const recovered = yield* runner(bucket, {
      writer: `${name}-recovery`,
      checkpointEvery,
      maxBatch,
    })
    yield* assignAll(recovered.engine)
    yield* Effect.forEach(
      expected,
      (value, key) =>
        Effect.flatMap(total(recovered.engine, `k${key}`), (actual) =>
          actual === value
            ? Effect.void
            : Effect.die(new Error(`k${key}: ${actual} instead of ${value}`)),
        ),
      { concurrency: concurrency, discard: true },
    )
    return { ...sample, drainMs, recoveryMs: performance.now() - recoveryStarted, recovered: true }
  })

const putBaseline = (bucket: Bucket, durationMs: number) =>
  Effect.gen(function* () {
    const bytes = new Uint8Array(65_536)
    yield* Effect.forEach(
      Array.from({ length: 32 }, (_, index) => index),
      (index) => bucket.create(`warm/${index}`, bytes),
      { discard: true },
    )
    const started = performance.now()
    const deadline = started + durationMs
    const latencies: Array<number> = []
    while (performance.now() < deadline) {
      const before = performance.now()
      if (!(yield* bucket.create(`raw/${latencies.length.toString(16)}`, bytes)))
        return yield* Effect.die(new Error("baseline key already exists"))
      latencies.push(performance.now() - before)
    }
    const elapsedMs = performance.now() - started
    return {
      actions: latencies.length,
      bytes: bytes.length,
      elapsedMs,
      throughput: latencies.length / (elapsedMs / 1_000),
      p50Ms: quantile(latencies, 0.5),
      p99Ms: quantile(latencies, 0.99),
    }
  })

const options = Effect.gen(function* () {
  const target = new URL(yield* Config.String("TEST_S3_URL"))
  const high = yield* Random.nextIntBetween(0, 0xffff_ffff)
  const low = yield* Random.nextIntBetween(0, 0xffff_ffff)
  return {
    endpoint: `${target.protocol}//${target.host}`,
    bucket: target.pathname.replace(/^\/+|\/+$/gu, ""),
    credentials: {
      accessKeyId: decodeURIComponent(target.username),
      secretAccessKey: decodeURIComponent(target.password),
    },
    prefix: `benchmarks/e2b/${high.toString(16)}-${low.toString(16)}/`,
  }
})

/**
 * A closed-loop engine diagnostic on the named store: one hot actor and 10,000
 * pre-created actors, plus a serial 64 KiB conditional PUT baseline. It checks every acknowledged
 * increment after drain and reopen. No network client, CPU quota or production SLO is inferred.
 */
const program = Effect.gen(function* () {
  const config = yield* Effect.all({
    durationMs: Config.Number("BENCH_DURATION_MS").pipe(Config.withDefault(5_000)),
    concurrency: Config.Number("BENCH_CONCURRENCY").pipe(Config.withDefault(64)),
    provider: Config.String("BENCH_PROVIDER").pipe(Config.withDefault("MinIO local")),
    adapter: Config.String("BENCH_ADAPTER").pipe(Config.withDefault("s3")),
    checkpointEvery: Config.Number("BENCH_CHECKPOINT_EVERY").pipe(Config.withDefault(64)),
    maxBatch: Config.Number("BENCH_MAX_BATCH").pipe(Config.withDefault(64)),
    diagnostics: Config.Boolean("BENCH_DIAGNOSTICS").pipe(Config.withDefault(false)),
    drainBudgetMs: Config.Number("BENCH_DRAIN_MS").pipe(Config.withDefault(30_000)),
  })
  if (
    !Number.isInteger(config.concurrency) ||
    config.concurrency < 1 ||
    !Number.isFinite(config.durationMs) ||
    config.durationMs <= 0 ||
    !Number.isInteger(config.maxBatch) ||
    config.maxBatch < 1 ||
    !Number.isInteger(config.checkpointEvery) ||
    config.checkpointEvery < 0 ||
    !Number.isFinite(config.drainBudgetMs) ||
    config.drainBudgetMs <= 0
  )
    return yield* Effect.die(
      new RangeError("invalid duration, concurrency, batch or checkpoint bound"),
    )
  if (!["s3", "fileSystem"].includes(config.adapter))
    return yield* Effect.die(new RangeError("adapter must be s3 or fileSystem"))
  const platform =
    globalThis.Bun === undefined
      ? (yield* Effect.promise(() => import("@effect/platform-node"))).NodeServices.layer
      : (yield* Effect.promise(() => import("@effect/platform-bun"))).BunServices.layer
  const services = yield* Layer.build(platform)
  const fs = Context.get(services, FileSystem.FileSystem)
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "akter-engine-bench-" })
  const location = config.adapter === "s3" ? yield* options : undefined
  const at = (name: string) =>
    location === undefined
      ? fileSystemBucket(`${directory}/${name}`).pipe(Effect.provideContext(services))
      : s3Bucket({ ...location, prefix: `${location.prefix}${name}/` })
  const bucket = yield* at("baseline")
  const baseline = yield* putBaseline(bucket, config.durationMs)
  const hot = yield* Effect.scoped(
    actionSample(
      yield* at("t1"),
      "t1",
      1,
      config.durationMs,
      config.concurrency,
      config.checkpointEvery,
      config.maxBatch,
      config.diagnostics,
      config.drainBudgetMs,
    ),
  )
  const broad = yield* Effect.scoped(
    actionSample(
      yield* at("t2"),
      "t2",
      10_000,
      config.durationMs,
      config.concurrency,
      config.checkpointEvery,
      config.maxBatch,
      config.diagnostics,
      config.drainBudgetMs,
    ),
  )
  yield* Console.log(
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      provider: config.provider,
      machine: hostname(),
      platform: `${process.platform}-${process.arch}`,
      runtime: globalThis.Bun === undefined ? `Node ${process.version}` : `Bun ${Bun.version}`,
      shards: SHARDS,
      durationMs: config.durationMs,
      concurrency: config.concurrency,
      checkpointEvery: config.checkpointEvery,
      maxBatch: config.maxBatch,
      drainBudgetMs: config.drainBudgetMs,
      baseline,
      t1: hot,
      t2: broad,
    }),
  )
})

await Effect.runPromise(Effect.scoped(program))
