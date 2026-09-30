import { BunCrypto } from "@effect/platform-bun"
import { ActorCluster, ActorTest } from "@durable-actors/core/testing"
import { Deferred, Duration, Effect, Layer } from "effect"
import { load, now, summarize } from "../measure.ts"
import {
  type ControlEffect,
  ControlProbe,
  ControlProbeCommands,
  controlAttempts,
  controlProbeEffects,
  controlWaiters,
} from "../probe/control.ts"
import type { Instruments } from "../backend.ts"
import { type CaseResult, measure, type Scenario, type ScenarioContext } from "../scenario.ts"

const RUNNERS = 3

const PROVIDER_MS = 50

interface ClusterSettings {
  readonly concurrency: number
  readonly cancelCheck: Duration.Input | undefined
  /** Runners without executors; turns on them still commit cancellations. */
  readonly withoutExecutors: ReadonlyArray<number>
}

/** Runs `body` against a fresh database and three in-process runners. */
const withCluster = <A, E>(
  context: ScenarioContext,
  settings: ClusterSettings,
  body: (instruments: Instruments | undefined) => Effect.Effect<A, E, ActorCluster>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      controlAttempts.clear()
      controlWaiters.clear()
      const database = yield* context.backend.database({ maxConnections: 10 })

      const cluster = yield* Layer.build(
        ActorTest.cluster({
          database: database.url!,
          runners: RUNNERS,
          shardLockExpiration: "30 seconds",
          actors: ControlProbeCommands,
          runnerActors: (runner) =>
            settings.withoutExecutors.includes(runner)
              ? Layer.empty
              : controlProbeEffects(PROVIDER_MS),
          executors:
            settings.cancelCheck === undefined
              ? { concurrency: settings.concurrency }
              : { concurrency: settings.concurrency, cancelCheck: settings.cancelCheck },
        }).pipe(Layer.provide(BunCrypto.layer)),
      ).pipe(Effect.orDie)

      return yield* body(database.instruments).pipe(Effect.provideContext(cluster))
    }),
  )

/** The most attempts of one actor that overlapped in time. */
const maxInFlight = (actors?: (actor: string) => boolean) => {
  const edges = new Map<string, Array<readonly [number, number]>>()

  for (const attempt of controlAttempts.values()) {
    if (actors !== undefined && !actors(attempt.actor)) continue
    const list = edges.get(attempt.actor) ?? []
    list.push([attempt.startedAt, 1], [attempt.endedAt ?? Number.POSITIVE_INFINITY, -1])
    edges.set(attempt.actor, list)
  }

  let most = 0

  for (const list of edges.values()) {
    let running = 0

    for (const [, step] of list.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
      running += step
      most = Math.max(most, running)
    }
  }

  return most
}

const expectAll = (labels: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const waits: Array<Deferred.Deferred<void>> = []

    for (const label of labels) {
      const done = yield* Deferred.make<void>()
      controlWaiters.set(label, done)
      waits.push(done)
    }

    return waits
  })

const performed = new Map<string, number>()

/** Performs `labels` in one turn on `actor` through `runner` and waits for every attempt. */
const performAndWait = (
  runner: number,
  actor: string,
  effect: ControlEffect,
  labels: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const cluster = yield* ActorCluster
    const finished = yield* expectAll(labels)
    yield* cluster.on(runner)(
      ControlProbe.get(actor).pipe(Effect.flatMap((probe) => probe.PerformAll({ effect, labels }))),
    )
    const at = yield* now

    for (const label of labels) performed.set(label, at)
    yield* Effect.forEach(finished, Deferred.await, { discard: true })
  })

/**
 * Due-to-start latency: from the reply to the performing turn, which follows
 * its commit and so the effect becoming due, to the provider seeing the attempt.
 */
const startLatency = (labels: Iterable<string>) => {
  const samples: Array<number> = []

  for (const label of labels) {
    const attempt = controlAttempts.get(label)
    const at = performed.get(label)

    if (attempt !== undefined && at !== undefined) samples.push(attempt.startedAt - at)
  }

  return summarize(samples)
}

const round = (value: number) => Math.round(value * 10) / 10

const memoryMb = () => round(process.memoryUsage().rss / 1_048_576)

const labelsFor = (actor: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${actor}/${index}`)

/**
 * Effect executor concurrency across runners; see its description. An attempt
 * that ends exactly when another starts does not overlap it.
 */
export const effectConcurrency: Scenario = {
  name: "effect-concurrency",
  description: `Three in-process runners on one Postgres, a ${PROVIDER_MS} ms fake provider: effect throughput uncapped and at concurrency.perActor 2, a hot actor at perActor 1 beside cold actors, and cancel-to-interrupt latency of running effects cancelled from turns on a runner that executes none of them, at the default and a 1 second executors.cancelCheck. The runners share one process and its CPU.`,
  run: (context) =>
    Effect.gen(function* () {
      if (context.backend.name !== "postgres") return []

      const actors = context.quick ? 100 : 1000
      const perActor = 10
      const results: Array<CaseResult> = []

      for (const [name, effect] of [
        ["throughput-uncapped", "Work"],
        ["throughput-per-actor-2", "PairWork"],
      ] as const)
        results.push(
          yield* withCluster(
            context,
            { concurrency: 64, cancelCheck: undefined, withoutExecutors: [] },
            (instruments) =>
              Effect.gen(function* () {
                performed.clear()
                yield* load({
                  workers: 16,
                  operations: 16,
                  operation: (index) =>
                    performAndWait(index % RUNNERS, `warm-${index}`, effect, [`warm-${index}/0`]),
                })
                controlAttempts.clear()

                const result = yield* measure({
                  name,
                  parameters: {
                    runners: RUNNERS,
                    actors,
                    effectsPerActor: perActor,
                    providerMs: PROVIDER_MS,
                    perActor: effect === "Work" ? "none" : 2,
                    workers: 64,
                  },
                  instruments,
                  workers: 64,
                  operations: actors,
                  operation: (index) =>
                    performAndWait(
                      index % RUNNERS,
                      `a-${index}`,
                      effect,
                      labelsFor(`a-${index}`, perActor),
                    ),
                })

                const start = startLatency(controlAttempts.keys())

                return {
                  ...result,
                  extra: {
                    effects: controlAttempts.size,
                    effectsPerSecond: round((controlAttempts.size / result.elapsedMs) * 1000),
                    statementsPerEffect:
                      result.statementsPerOperation === null
                        ? "n/a"
                        : round((result.statementsPerOperation / perActor) * 100) / 100,
                    startP50Ms: round(start.p50),
                    startP95Ms: round(start.p95),
                    startP99Ms: round(start.p99),
                    maxInFlightPerActor: maxInFlight(),
                    rssMb: memoryMb(),
                  },
                } satisfies CaseResult
              }),
          ),
        )

      const hotEffects = context.quick ? 100 : 1000

      results.push(
        yield* withCluster(
          context,
          { concurrency: 64, cancelCheck: undefined, withoutExecutors: [] },
          (instruments) =>
            Effect.gen(function* () {
              performed.clear()
              controlAttempts.clear()

              const result = yield* measure({
                name: "hot-actor-per-actor-1",
                parameters: {
                  runners: RUNNERS,
                  hotEffects,
                  coldActors: actors,
                  providerMs: PROVIDER_MS,
                  perActor: 1,
                  workers: 64,
                },
                instruments,
                workers: 64,
                operations: actors + 1,
                operation: (index) =>
                  index === 0
                    ? performAndWait(0, "hot", "SingleWork", labelsFor("hot", hotEffects))
                    : performAndWait(index % RUNNERS, `cold-${index}`, "SingleWork", [
                        `cold-${index}/0`,
                      ]),
              })

              const cold = startLatency(
                [...controlAttempts.keys()].filter((label) => label.startsWith("cold-")),
              )

              const hot = [...controlAttempts.entries()].filter(([label]) =>
                label.startsWith("hot/"),
              )

              const hotEnd = Math.max(...hot.map(([, attempt]) => attempt.endedAt ?? 0))
              const hotStart = Math.min(...hot.map(([label]) => performed.get(label) ?? 0))

              return {
                ...result,
                extra: {
                  coldStartP50Ms: round(cold.p50),
                  coldStartP95Ms: round(cold.p95),
                  coldStartP99Ms: round(cold.p99),
                  hotEffectsPerSecond: round((hot.length / (hotEnd - hotStart)) * 1000),
                  hotMaxInFlight: maxInFlight((actor) => actor === "hot"),
                  coldMaxInFlight: maxInFlight((actor) => actor !== "hot"),
                  rssMb: memoryMb(),
                },
              } satisfies CaseResult
            }),
        ),
      )

      const hangs = context.quick ? 100 : 1000

      for (const [name, cancelCheck] of [
        ["cancel-default-check", undefined],
        ["cancel-1s-check", "1 second"],
      ] as const)
        results.push(
          yield* withCluster(
            context,
            { concurrency: hangs, cancelCheck, withoutExecutors: [0] },
            (instruments) =>
              Effect.gen(function* () {
                const cluster = yield* ActorCluster
                const owned: Array<string> = []

                for (let index = 0; owned.length < hangs; index++) {
                  const ref = (yield* cluster.on(0)(ControlProbe.get(`h-${index}`))).ref

                  if ((yield* cluster.owner(ref)) === 0) owned.push(`h-${index}`)
                }

                const started = new Map<string, Deferred.Deferred<void>>()

                yield* load({
                  workers: 64,
                  operations: hangs,
                  operation: (index) =>
                    cluster.on(0)(
                      ControlProbe.get(owned[index]!).pipe(
                        Effect.flatMap((probe) =>
                          probe.PerformAll({ effect: "Hang", labels: [`${owned[index]}/hang`] }),
                        ),
                      ),
                    ),
                })

                while (controlAttempts.size < hangs) yield* Effect.sleep("20 millis")

                for (const actor of owned) {
                  const done = yield* Deferred.make<void>()
                  controlWaiters.set(`${actor}/hang`, done)
                  started.set(actor, done)
                }

                const cancelledAt = new Map<string, number>()

                const result = yield* measure({
                  name,
                  parameters: {
                    runners: RUNNERS,
                    runningEffects: hangs,
                    cancelCheck: cancelCheck ?? "default (lease / 3 = 20 s)",
                    workers: hangs,
                  },
                  instruments,
                  workers: hangs,
                  operations: hangs,
                  operation: (index) =>
                    Effect.gen(function* () {
                      const actor = owned[index]!
                      cancelledAt.set(actor, yield* now)
                      yield* cluster.on(0)(
                        ControlProbe.get(actor).pipe(
                          Effect.flatMap((probe) => probe.CancelAll([`${actor}/hang`])),
                        ),
                      )
                      yield* Deferred.await(started.get(actor)!)
                    }),
                })

                const interrupt = summarize(
                  owned.map(
                    (actor) =>
                      (controlAttempts.get(`${actor}/hang`)?.endedAt ?? Number.NaN) -
                      cancelledAt.get(actor)!,
                  ),
                )

                return {
                  ...result,
                  extra: {
                    cancelToInterruptP50Ms: round(interrupt.p50),
                    cancelToInterruptP95Ms: round(interrupt.p95),
                    cancelToInterruptP99Ms: round(interrupt.p99),
                    cancelToInterruptMaxMs: round(interrupt.max),
                    rssMb: memoryMb(),
                  },
                } satisfies CaseResult
              }),
          ),
        )

      return results
    }),
}
