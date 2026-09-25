import { BunCrypto } from "@effect/platform-bun"
import { ActorCluster, ActorTest } from "durable-actors/testing"
import { Effect, Fiber, Layer, Schedule } from "effect"
import { load, now } from "../measure.ts"
import { Probe } from "../probe/contract.ts"
import { ProbeLive } from "../probe/layer.ts"
import { type CaseResult, measure, type Scenario, type ScenarioContext } from "../scenario.ts"

const ACTORS = 256

const EXPIRATION_SECONDS = 5

/** Runs `body` against a fresh database and an in-process cluster of `runners`. */
const withCluster = <A, E>(
  context: ScenarioContext,
  runners: number,
  body: (
    instruments: Parameters<Parameters<ScenarioContext["withRuntime"]>[1]>[0],
  ) => Effect.Effect<A, E, ActorCluster>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = yield* context.backend.database({ maxConnections: 2 })

      const cluster = yield* Layer.build(
        ActorTest.cluster({
          database: database.url!,
          runners,
          shardLockExpiration: `${EXPIRATION_SECONDS} seconds`,
          actors: ProbeLive,
        }).pipe(Layer.provide(BunCrypto.layer)),
      ).pipe(Effect.orDie)

      return yield* body(database.instruments).pipe(Effect.provideContext(cluster))
    }),
  )

const add = (runner: number, actor: number) =>
  ActorCluster.use((cluster) =>
    cluster.on(runner)(Probe.get(`a-${actor}`).pipe(Effect.flatMap((probe) => probe.Add(1)))),
  )

/**
 * Every operation goes to one of `runners` in turn and every actor is reached
 * through every runner, so most turns cross from the calling runner to the
 * owner over the serializing in-process transport.
 */
const spread = (runners: number) => (index: number) =>
  add(index % runners, Math.floor(index / runners) % ACTORS)

export const multiRunner: Scenario = {
  name: "multi-runner",
  description:
    "In-process runners on one Postgres (ActorTest.cluster): turns per second with 1, 2, and 4 runners, and a runner kill under load with lock expiry, takeover, and resumed service timed separately. The runners share one process and its CPU, so this measures routing and ownership cost, not scale-out.",
  run: (context) =>
    Effect.gen(function* () {
      // The harness refuses PGlite: several runners need independent connections.
      if (context.backend.name !== "postgres") return []

      const quick = context.profile === "quick"
      const results: Array<CaseResult> = []

      for (const runners of [1, 2, 4])
        results.push(
          yield* withCluster(context, runners, (instruments) =>
            Effect.gen(function* () {
              yield* load({ workers: 64, operations: ACTORS * runners, operation: spread(runners) })

              return yield* measure({
                name: `runners-${runners}`,
                parameters: { runners, actors: ACTORS, workers: 64 },
                instruments,
                workers: 64,
                durationMs: quick ? 3000 : 15_000,
                operation: spread(runners),
              })
            }),
          ),
        )

      results.push(
        yield* withCluster(context, 3, (instruments) =>
          Effect.gen(function* () {
            const cluster = yield* ActorCluster
            yield* load({ workers: 64, operations: ACTORS * 3, operation: spread(3) })

            let victim = 0

            while (
              (yield* cluster.owner((yield* cluster.on(1)(Probe.get(`a-${victim}`))).ref)) !== 0
            )
              victim += 1
            const ref = (yield* cluster.on(1)(Probe.get(`a-${victim}`))).ref

            // Callers use the survivors only; a caller on the killed runner dies with it.
            const survivors = (index: number) =>
              add(1 + (index % 2), Math.floor(index / 2) % ACTORS)

            const drill = yield* Effect.gen(function* () {
              yield* Effect.sleep("2 seconds")
              const killed = yield* now
              yield* cluster.kill(0)

              const since = (owner: (current: number | undefined) => boolean) =>
                cluster.owner(ref).pipe(
                  Effect.repeat({ schedule: Schedule.spaced("10 millis"), until: owner }),
                  Effect.andThen(now),
                  Effect.map((at) => Math.round(at - killed)),
                )

              const [expired, taken, resumed] = yield* Effect.all(
                [
                  since((current) => current !== 0),
                  since((current) => current !== undefined && current !== 0),
                  add(1, victim).pipe(
                    Effect.andThen(now),
                    Effect.map((at) => Math.round(at - killed)),
                  ),
                ],
                { concurrency: "unbounded" },
              )

              return { lockExpiredMs: expired, takeoverMs: taken, resumedMs: resumed }
            }).pipe(Effect.orDie, Effect.forkChild)

            const result = yield* measure({
              name: "kill-1-of-3",
              parameters: {
                runners: 3,
                actors: ACTORS,
                workers: 16,
                shardLockExpirationSeconds: EXPIRATION_SECONDS,
              },
              instruments,
              workers: 16,
              durationMs: quick ? 12_000 : 20_000,
              operation: survivors,
            })

            return { ...result, extra: yield* Fiber.join(drill) } satisfies CaseResult
          }),
        ),
      )

      return results
    }),
}
