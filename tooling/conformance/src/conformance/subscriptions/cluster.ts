import { Effect, Layer, Stream } from "effect"
import { ActorTest } from "../../../../../packages/akter/src/testing/actor-test.ts"
import { clusterLayer, ActorCluster } from "../../cluster.ts"
import type { ConformanceCase, ConformanceEnvironment } from "../../conformance.ts"
import {
  Live,
  SubFollower,
  SubOrder,
  SubSummary,
  type SubscriptionsFixture,
  reset,
  subscriptionsLayer,
} from "./actors.ts"
import { followerLog, logOf, sourceRows, tagMismatches } from "./harness.ts"

/** Builds a fresh database and `runners` runners on it for one case. */
const withCluster = <A, E>(
  environment: ConformanceEnvironment,
  fixture: SubscriptionsFixture,
  runners: number,
  body: Effect.Effect<A, E, ActorCluster>,
  holdersOnly?: ReadonlyArray<number>,
) =>
  environment.run(
    Effect.gen(function* () {
      yield* reset(fixture)
      const database = yield* environment.freshDatabase

      const context = yield* Layer.build(
        clusterLayer({
          database,
          runners,
          holdersOnly,
          shardLockExpiration: "3 seconds",
          actors: subscriptionsLayer(fixture),
          relay: { claimLease: "3 seconds", poll: "200 millis" },
        }),
      )

      return yield* body.pipe(Effect.provideContext(context))
    }),
  )

const on = <A, E, R>(runner: number, effect: Effect.Effect<A, E, R>) =>
  ActorCluster.use((cluster) => cluster.on(runner)(effect))

/** Multi-runner subscription cases: subscribers wake across runners and one source's events apply in cursor order under redelivery. */
export const subscriptionsClusterConformance: ReadonlyArray<ConformanceCase<SubscriptionsFixture>> =
  [
    {
      name: "wakes a subscriber parked on another runner and flushes the delivery's broadcast to its holder",
      requiresFreshDatabase: true,
      requiresIndependentConnections: true,
      timeoutMs: 120_000,
      run: ({ expect, environment, fixture }) =>
        withCluster(
          environment,
          fixture,
          3,
          Effect.gen(function* () {
            const cluster = yield* ActorCluster
            yield* cluster.ready
            const holder = cluster.on(0)
            const tenant = yield* holder(ActorTest.use((test) => Effect.succeed(test.tenant)))
            const ref = { tenant, actor: "SubSummary", id: "cross-c" }
            yield* holder(
              SubSummary.get("cross-c").pipe(Effect.flatMap((summary) => summary.Touch())),
            )

            const connection = yield* holder(
              ActorTest.use((test) => test.connect(ref, Live, undefined)),
            )

            const generation = holder(
              ActorTest.use((test) => test.inspect(ref)).pipe(
                Effect.map(({ generation }) => BigInt(generation!)),
              ),
            )

            const owner = yield* cluster.owner(ref)
            expect(owner === undefined || owner === 0).toBe(false)
            yield* cluster.on(owner!)(ActorTest.use((test) => test.hibernate(ref)))
            const parked = yield* generation

            yield* holder(
              SubOrder.get("cross-o").pipe(
                Effect.flatMap((order) => order.Place({ customerId: "cross-c", amount: 1 })),
              ),
            )

            const frames = yield* connection.frames.pipe(
              Stream.take(1),
              Stream.runCollect,
              Effect.timeout("30 seconds"),
            )

            expect(Array.from(frames)).toEqual(["cross-o#1:OrderPlaced"])
            expect((yield* generation) > parked).toBe(true)
            expect(yield* holder(logOf("SubSummary", "cross-c"))).toEqual(["cross-o#1:OrderPlaced"])
            yield* connection.close
          }),
          [0],
        ),
    },
    {
      name: "applies one source's events in cursor order under redelivery and two runners",
      requiresFreshDatabase: true,
      requiresIndependentConnections: true,
      timeoutMs: 120_000,
      run: ({ expect, environment, fixture }) =>
        withCluster(
          environment,
          fixture,
          2,
          Effect.gen(function* () {
            const followers = Array.from({ length: 8 }, (_, index) => `cluster-f${index}`)

            for (const [index, id] of followers.entries())
              yield* on(
                index % 2,
                Effect.flatMap(SubFollower.get(id), (f) => f.Follow({ source: "cluster-order" })),
              )

            for (;;) {
              const registered = yield* on(0, sourceRows("cluster-order"))

              if (registered.filter((row) => row.active).length === followers.length) break
              yield* Effect.sleep("50 millis")
            }

            const defected = new Set<string>()
            fixture.behave = (entry) => {
              if (entry.includes("#2:") && !defected.has(entry)) {
                defected.add(entry)

                return "defect"
              }

              return "apply"
            }

            for (let round = 0; round < 3; round++)
              yield* on(
                round % 2,
                Effect.flatMap(SubOrder.get("cluster-order"), (o) =>
                  o.Place({ customerId: "cluster-c", amount: round }),
                ),
              )

            const expected = ["1", "2", "3"].map((cursor) => `cluster-order#${cursor}:OrderPlaced`)

            for (;;) {
              const logs = yield* on(0, Effect.forEach(followers, followerLog))

              if (logs.every((log) => log.length >= 3)) {
                for (const log of logs) expect(log).toEqual(expected)

                break
              }

              yield* Effect.sleep("100 millis")
            }

            for (const id of followers)
              expect(
                yield* on(
                  0,
                  ActorTest.use((test) =>
                    test.receiptsFor({ tenant: test.tenant, actor: "SubFollower", id }, "OnOrder"),
                  ),
                ),
              ).toBe(3)

            expect(yield* on(0, tagMismatches)).toEqual([])
          }).pipe(Effect.timeout("100 seconds"), Effect.orDie),
        ),
    },
  ]
