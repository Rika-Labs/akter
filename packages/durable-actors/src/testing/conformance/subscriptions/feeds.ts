import { Deferred, Effect, Fiber, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ActorTest } from "../../actor-test.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { CLAIM_LEASE, ExplainOutput, planNodes } from "../outbox.ts"
import { SubFollower, SubOrder, type SubscriptionsFixture } from "./actors.ts"
import {
  crashOnce,
  drain,
  followerLog,
  handlerRuns,
  outboxOf,
  query,
  run,
  sourceRows,
  tagMismatches,
} from "./harness.ts"

/** Feed rows, the tag summary, and wake-ups of event subscriptions. */
export const subscriptionFeedConformance: ReadonlyArray<ConformanceCase<SubscriptionsFixture>> = [
  {
    name: "reactivates a subscription over its tombstone, so the source's next event is delivered",
    run: ({ expect, environment, fixture }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const follower = yield* SubFollower.get("revive-follower")
          yield* follower.Follow({ source: "revive-order" })
          yield* drain
          yield* follower.Unfollow("revive-order")
          yield* drain
          expect(yield* sourceRows("revive-order")).toMatchObject([
            { subscriber_id: "revive-follower", epoch: "2", active: false, due: false },
          ])
          expect(yield* tagMismatches).toEqual([])

          yield* follower.Follow({ source: "revive-order" })
          yield* drain
          yield* (yield* SubOrder.get("revive-order")).Place({ customerId: "r", amount: 1 })
          yield* drain

          expect(yield* followerLog("revive-follower")).toEqual(["revive-order#1:OrderPlaced"])
          expect(yield* sourceRows("revive-order")).toMatchObject([
            { subscriber_id: "revive-follower", epoch: "3", active: true, delivered: "1" },
          ])
          expect(yield* tagMismatches).toEqual([])
        }),
      ),
  },
  {
    name: "tombstones a caught-up row and delivers Rejected when a resubscribe names a cursor above the source's head",
    run: ({ expect, environment, fixture }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const follower = yield* SubFollower.get("above-follower")
          const order = yield* SubOrder.get("above-order")
          yield* follower.Follow({ source: "above-order" })
          yield* drain
          yield* order.Place({ customerId: "a", amount: 1 })
          yield* drain
          expect(yield* sourceRows("above-order")).toMatchObject([
            { epoch: "1", active: true, delivered: "1", due: false },
          ])

          yield* follower.Follow({ source: "above-order", from: "9" })
          yield* drain
          yield* order.Place({ customerId: "a", amount: 2 })
          yield* drain

          expect(yield* followerLog("above-follower")).toEqual([
            "above-order#1:OrderPlaced",
            "above-order!rejected:9",
          ])
          expect(yield* sourceRows("above-order")).toMatchObject([
            { subscriber_id: "above-follower", epoch: "2", active: false, due: false },
          ])
          expect(yield* tagMismatches).toEqual([])
        }),
      ),
  },
  {
    name: "expands a feed row once its lease ends when the relay dies after claiming it",
    run: ({ expect, environment, fixture }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          yield* (yield* SubFollower.get("feeddie-follower")).Follow({ source: "feeddie-order" })
          yield* drain

          const crash = crashOnce(
            fixture,
            "afterClaim",
            (request) => request.command === "$feed" && request.ref.id === "feeddie-order",
          )

          yield* (yield* SubOrder.get("feeddie-order")).Place({ customerId: "f", amount: 1 })
          yield* drain
          expect(crash.crashed).toBe(true)
          expect(yield* followerLog("feeddie-follower")).toEqual([])
          expect(yield* outboxOf("SubOrder", "feeddie-order", "feed")).toBe(1)

          yield* test.advance(CLAIM_LEASE)

          expect(yield* followerLog("feeddie-follower")).toEqual(["feeddie-order#1:OrderPlaced"])
          expect(handlerRuns(fixture, "SubFollower/feeddie-follower")).toBe(1)
          expect(yield* outboxOf("SubOrder", "feeddie-order", "feed")).toBe(0)
        }),
      ),
  },
  {
    name: "writes one feed row per publishing turn whatever the subscriber count",
    run: ({ expect, environment, fixture }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest

          for (const [source, followers] of [
            ["feed-one", 1],
            ["feed-many", 12],
          ] as const) {
            for (let index = 0; index < followers; index++)
              yield* (yield* SubFollower.get(`${source}-f${index}`)).Follow({ source })
            yield* drain

            const pause = yield* test.pauseNext("afterClaim")
            yield* (yield* SubOrder.get(source)).PlaceMany({ customerId: "f", count: 3 })
            const draining = yield* drain.pipe(Effect.forkChild)
            yield* pause.reached
            expect(yield* outboxOf("SubOrder", source, "feed")).toBe(1)
            expect(
              (yield* test.inspect({ tenant: test.tenant, actor: "SubOrder", id: source })).outbox,
            ).toBe(0)
            yield* pause.release
            yield* Fiber.join(draining)
            expect(yield* outboxOf("SubOrder", source, "feed")).toBe(0)

            for (let index = 0; index < followers; index++)
              expect((yield* followerLog(`${source}-f${index}`)).length).toBe(3)
          }
        }),
      ),
  },
  {
    name: "writes no feed row for an actor with no subscriptions",
    run: ({ expect, environment, fixture }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          yield* (yield* SubOrder.get("quiet-order")).Note("nobody listens")
          expect(yield* outboxOf("SubOrder", "quiet-order", "feed")).toBe(0)
          expect(yield* sourceRows("quiet-order")).toEqual([])
        }),
      ),
  },
  {
    name: "probes the tag summary by key with 10^5 non-matching rows",
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sql = yield* SqlClient.SqlClient
          const routingKey = "1"

          yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
            SELECT ${routingKey}::bigint, ${test.tenant}, 'SubProbe', 'p' || n
            FROM generate_series(1, 100000) AS n`.pipe(Effect.orDie)
          yield* sql`INSERT INTO actor_subscription_tags (routing_key, tenant_id, source_type, source_id, event, rows)
            SELECT ${routingKey}::bigint, ${test.tenant}, 'SubProbe', 'p' || n, 'OrderPlaced', 1
            FROM generate_series(1, 100000) AS n`.pipe(Effect.orDie)
          yield* sql`ANALYZE actor_subscription_tags`.pipe(Effect.orDie)

          const [row] = yield* sql<{
            "QUERY PLAN": unknown
          }>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT 1 FROM actor_subscription_tags t
            WHERE t.routing_key = ${routingKey}::bigint AND t.tenant_id = ${test.tenant}
              AND t.source_type = 'SubProbe' AND t.source_id = 'missing' AND t.event IN ('OrderPlaced', 'OrderCancelled')`.pipe(
            Effect.orDie,
          )

          const [explained] = yield* Schema.decodeUnknownEffect(ExplainOutput)(
            row!["QUERY PLAN"],
          ).pipe(Effect.orDie)

          const nodes = planNodes(explained.Plan)
          expect(nodes.some((node) => node["Index Name"] === "actor_subscription_tags_pkey")).toBe(
            true,
          )
          expect(nodes.some((node) => node["Node Type"] === "Seq Scan")).toBe(false)
          expect(explained.Plan["Actual Rows"]).toBe(0)
          expect(
            nodes.reduce(
              (sum, node) => sum + node["Shared Hit Blocks"] + node["Shared Read Blocks"],
              0,
            ) < 16,
          ).toBe(true)

          yield* sql`DELETE FROM actor_subscription_tags WHERE source_type = 'SubProbe'`.pipe(
            Effect.orDie,
          )
          yield* sql`DELETE FROM actor_generations WHERE actor_type = 'SubProbe'`.pipe(Effect.orDie)
        }),
      ),
  },
  {
    name: "leases the rows an expansion makes due and starts their delivery without a claim pass",
    run: ({ expect, environment, fixture }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          yield* (yield* SubFollower.get("lease-follower")).Follow({ source: "lease-order" })
          yield* drain

          const order: Array<string> = []
          const claimed = yield* Deferred.make<void>()
          fixture.hook = (point, request) => {
            if (point === "afterClaim" && request.commandId === "lease-follower") {
              order.push("delivery")

              return Deferred.succeed(claimed, undefined).pipe(Effect.asVoid)
            }

            if (point === "afterExpand" && request.ref.id === "lease-order")
              return Deferred.await(claimed).pipe(
                Effect.timeout("2 seconds"),
                Effect.ignore,
                Effect.andThen(Effect.sync(() => order.push("expanded"))),
              )

            return Effect.void
          }

          yield* (yield* SubOrder.get("lease-order")).Place({ customerId: "l", amount: 1 })
          yield* drain

          expect(order).toEqual(["delivery", "expanded"])
          expect(yield* followerLog("lease-follower")).toEqual(["lease-order#1:OrderPlaced"])
          expect(yield* sourceRows("lease-order")).toMatchObject([
            { delivered: "1", due: false, attempts: 0 },
          ])
        }),
      ),
  },
  {
    name: "loses no wake when a commit races a settle or an expansion",
    run: ({ expect, environment, fixture }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const order = yield* SubOrder.get("race-order")
          yield* (yield* SubFollower.get("race-follower")).Follow({ source: "race-order" })
          yield* drain

          const pause = yield* test.pauseNext("afterSettleSnapshot")
          yield* order.Place({ customerId: "r", amount: 1 })
          const draining = yield* drain.pipe(Effect.forkChild)
          yield* pause.reached
          yield* order.Place({ customerId: "r", amount: 2 })

          for (;;) {
            if ((yield* outboxOf("SubOrder", "race-order", "feed")) === 0) break
            yield* Effect.sleep("20 millis")
          }

          yield* pause.release
          yield* Fiber.join(draining)
          yield* drain

          expect(yield* followerLog("race-follower")).toEqual([
            "race-order#1:OrderPlaced",
            "race-order#2:OrderPlaced",
          ])
          expect(yield* sourceRows("race-order")).toMatchObject([{ delivered: "2", due: false }])
        }),
      ),
  },
  {
    name: "keeps a backing-off row's due time when new commits expand the feed",
    run: ({ expect, environment, fixture }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const order = yield* SubOrder.get("backoff-order")
          yield* (yield* SubFollower.get("backoff-follower")).Follow({ source: "backoff-order" })
          yield* drain
          fixture.behave = (entry) =>
            entry.startsWith("SubFollower/backoff-follower/") ? "defect" : "apply"
          yield* order.Place({ customerId: "b", amount: 1 })
          yield* drain

          const due = () =>
            query(
              (sql) => sql<{ due_at_ms: string }>`SELECT due_at_ms::text AS due_at_ms
                FROM actor_subscriptions WHERE tenant_id = ${test.tenant}
                  AND source_id = 'backoff-order' AND subscriber_id = 'backoff-follower'`,
            ).pipe(Effect.map((rows) => rows[0]!.due_at_ms))

          const backingOff = yield* due()
          yield* order.Place({ customerId: "b", amount: 2 })
          yield* drain
          expect(yield* due()).toBe(backingOff)
          const [backedOff] = yield* sourceRows("backoff-order")
          expect(backedOff).toMatchObject({ delivered: "0", attempts: 1 })
          expect(backedOff!.last_error?.includes("Handler defect")).toBe(true)

          fixture.behave = () => "apply"
          yield* test.advance(CLAIM_LEASE)
          expect(yield* followerLog("backoff-follower")).toEqual([
            "backoff-order#1:OrderPlaced",
            "backoff-order#2:OrderPlaced",
          ])
        }),
      ),
  },
]
