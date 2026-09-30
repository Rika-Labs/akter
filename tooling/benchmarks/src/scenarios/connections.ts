import { BunCrypto } from "@effect/platform-bun"
import { ActorTest, type TestConnection } from "@durable-actors/core/testing"
import { Effect, Layer, Queue, Stream } from "effect"
import type { Instruments } from "../backend.ts"
import { load } from "../measure.ts"
import { Feed, LiveProbe, LiveProbeLive } from "../probe/connections.ts"
import {
  type CaseResult,
  DEFAULT_POOL,
  measure,
  type Scenario,
  type ScenarioContext,
} from "../scenario.ts"

type Services = Layer.Success<ReturnType<typeof testLayer>>

const testLayer = (database: NonNullable<Parameters<typeof ActorTest.layer>[0]>["database"]) =>
  Layer.fresh(
    LiveProbeLive.pipe(
      Layer.provideMerge(ActorTest.layer({ database })),
      Layer.provide(BunCrypto.layer),
      Layer.orDie,
    ),
  )

/**
 * Connections are opened through `ActorTest`'s in-process transport, so each
 * case builds a test runtime on the case database instead of `withRuntime`'s.
 */
const withConnections = <A, E>(
  context: ScenarioContext,
  body: (instruments: Instruments | undefined) => Effect.Effect<A, E, Services>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = yield* context.backend.database({ maxConnections: DEFAULT_POOL })
      const services = yield* Layer.build(testLayer(database.url))

      return yield* body(database.instruments).pipe(Effect.provideContext(services), Effect.orDie)
    }),
  )

const nextFrame = (connection: TestConnection<typeof Feed>) =>
  connection.frames.pipe(Stream.take(1), Stream.runDrain)

const echo = (connection: TestConnection<typeof Feed>) =>
  Effect.andThen(connection.send("ping"), nextFrame(connection))

/**
 * Connection frames and broadcasts through the holder: a frame answered by a
 * warm owner, a frame that wakes a parked owner, and a committed broadcast
 * reaching 1 and 64 connections. Then streams on the owner: a subscription
 * that emits one element and ends, and a commit reaching a `read.follow`
 * subscriber.
 */
export const connections: Scenario = {
  name: "connections",
  description:
    "Connection round trips through the in-process holder: a frame echoed by a warm owner, a frame that wakes a hibernated owner, and a turn's broadcast reaching 1 and 64 parked connections; stream subscriptions, and a commit reaching a read.follow subscriber.",
  run: (context) =>
    Effect.gen(function* () {
      const operations = context.quick ? 200 : 2000
      const results: Array<CaseResult> = []

      results.push(
        yield* withConnections(context, (instruments) =>
          Effect.gen(function* () {
            const test = yield* ActorTest
            const probe = yield* LiveProbe.get("warm")
            const connection = yield* test.connect(probe.ref, Feed, undefined)
            yield* load({ workers: 1, operations: 50, operation: () => echo(connection) })

            return yield* measure({
              name: "frame-warm",
              parameters: { connections: 1, workers: 1 },
              instruments,
              workers: 1,
              operations,
              operation: () => echo(connection),
              listStatements: true,
            })
          }),
        ),
      )

      results.push(
        yield* withConnections(context, (instruments) =>
          Effect.gen(function* () {
            const test = yield* ActorTest
            const probe = yield* LiveProbe.get("parked")
            const connection = yield* test.connect(probe.ref, Feed, undefined)
            const wake = () => Effect.andThen(test.hibernate(probe.ref), echo(connection))
            yield* load({ workers: 1, operations: 20, operation: wake })

            return yield* measure({
              name: "frame-parked",
              parameters: { connections: 1, workers: 1 },
              instruments,
              workers: 1,
              operations: Math.round(operations / 2),
              operation: wake,
              listStatements: true,
            })
          }),
        ),
      )

      for (const fanout of [1, 64])
        results.push(
          yield* withConnections(context, (instruments) =>
            Effect.gen(function* () {
              const test = yield* ActorTest
              const probe = yield* LiveProbe.get(`fanout-${fanout}`)

              const held = yield* Effect.forEach(
                Array.from({ length: fanout }),
                () => test.connect(probe.ref, Feed, undefined),
                { concurrency: 16 },
              )

              const shout = () =>
                Effect.andThen(
                  probe.Shout("hello"),
                  Effect.forEach(held, nextFrame, { concurrency: "unbounded", discard: true }),
                )

              yield* load({ workers: 1, operations: 20, operation: shout })

              return yield* measure({
                name: `broadcast-${fanout}`,
                parameters: { connections: fanout, workers: 1 },
                instruments,
                workers: 1,
                operations: Math.round(operations / 2),
                operation: shout,
                listStatements: true,
              })
            }),
          ),
        )

      results.push(
        yield* withConnections(context, (instruments) =>
          Effect.gen(function* () {
            const probe = yield* LiveProbe.get("subscribe")
            const once = () => Stream.runDrain(probe.Once())
            yield* load({ workers: 1, operations: 50, operation: once })

            return yield* measure({
              name: "stream-subscribe",
              parameters: { subscriptions: 1, workers: 1 },
              instruments,
              workers: 1,
              operations,
              operation: once,
              listStatements: true,
            })
          }),
        ),
      )

      results.push(
        yield* withConnections(context, (instruments) =>
          Effect.scoped(
            Effect.gen(function* () {
              const probe = yield* LiveProbe.get("follow")
              const received = yield* Queue.unbounded<string>()
              yield* probe.Tail().pipe(
                Stream.runForEach((text) => Queue.offer(received, text)),
                Effect.forkScoped,
              )

              const logged = () => Effect.andThen(probe.Log("hello"), Queue.take(received))
              yield* load({ workers: 1, operations: 50, operation: logged })

              return yield* measure({
                name: "stream-follow",
                parameters: { subscriptions: 1, workers: 1 },
                instruments,
                workers: 1,
                operations,
                operation: logged,
                listStatements: true,
              })
            }),
          ),
        ),
      )

      return results
    }),
}
