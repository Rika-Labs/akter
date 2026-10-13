import { Config, Console, Effect, Random, Result, Schema } from "effect"
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
) =>
  Effect.gen(function* () {
    const opened = yield* runner(bucket, { writer: name, checkpointEvery: 64 })
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
    const drained = yield* opened.engine.drain("30 seconds")
    if (drained.outcome !== "clean")
      return yield* Effect.die(new Error("benchmark drain timed out"))
    const recovered = yield* runner(bucket, { writer: `${name}-recovery`, checkpointEvery: 64 })
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
    return {
      name,
      actions,
      failures,
      elapsedMs,
      throughput: actions / (elapsedMs / 1_000),
      p50Ms: quantile(latencies, 0.5),
      p99Ms: quantile(latencies, 0.99),
    } satisfies Sample
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
 * A closed-loop engine diagnostic on the named S3-compatible provider: one hot actor and 10,000
 * pre-created actors, plus a serial 64 KiB conditional PUT baseline. It checks every acknowledged
 * increment after drain and reopen. No network client, CPU quota or production SLO is inferred.
 */
const program = Effect.gen(function* () {
  const config = yield* Effect.all({
    durationMs: Config.Number("BENCH_DURATION_MS").pipe(Config.withDefault(5_000)),
    concurrency: Config.Number("BENCH_CONCURRENCY").pipe(Config.withDefault(64)),
    provider: Config.String("BENCH_PROVIDER").pipe(Config.withDefault("MinIO local")),
  })
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1 || config.durationMs <= 0)
    return yield* Effect.die(new RangeError("duration and integer concurrency must be positive"))
  const location = yield* options
  const bucket = yield* s3Bucket(location)
  const baseline = yield* putBaseline(bucket, config.durationMs)
  const hot = yield* Effect.scoped(
    actionSample(
      yield* s3Bucket({ ...location, prefix: `${location.prefix}t1/` }),
      "t1",
      1,
      config.durationMs,
      config.concurrency,
    ),
  )
  const broad = yield* Effect.scoped(
    actionSample(
      yield* s3Bucket({ ...location, prefix: `${location.prefix}t2/` }),
      "t2",
      10_000,
      config.durationMs,
      config.concurrency,
    ),
  )
  yield* Console.log(
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      provider: config.provider,
      machine: `${process.platform}-${process.arch}`,
      runtime: globalThis.Bun === undefined ? `Node ${process.version}` : `Bun ${Bun.version}`,
      shards: SHARDS,
      durationMs: config.durationMs,
      concurrency: config.concurrency,
      baseline,
      t1: hot,
      t2: broad,
    }),
  )
})

await Effect.runPromise(Effect.scoped(program))
