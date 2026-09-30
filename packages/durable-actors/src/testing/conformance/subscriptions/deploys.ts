import { Cause, Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Tenant } from "../../../index.ts"
import { ActorTest } from "../../actor-test.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { SubFollower, SubOrder, subOrderLayer } from "./actors.ts"
import {
  drain,
  followerLog,
  handlerRuns,
  query,
  run,
  sourceRows,
  tagMismatches,
} from "./harness.ts"
import { CLAIM_LEASE } from "../outbox.ts"

/** Deploy-time registration checks and tag-summary upkeep of event subscriptions. */
export const subscriptionDeployConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "delivers a class added to a dynamic subscription by a deploy, and never narrows a row",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      Effect.gen(function* () {
        const tenant = yield* Effect.promise(() =>
          run(
            environment,
            fixture,
            Effect.gen(function* () {
              const test = yield* ActorTest
              yield* (yield* SubFollower.get("widen-follower")).Follow({ source: "widen-order" })
              yield* drain
              yield* query(
                (sql) => sql`UPDATE actor_subscriptions SET events = ARRAY['OrderPlaced']
                  WHERE tenant_id = ${test.tenant} AND source_id = 'widen-order'
                    AND subscriber_id = 'widen-follower'`,
              )
              yield* query(
                (sql) => sql`DELETE FROM actor_subscription_tags WHERE tenant_id = ${test.tenant}
                  AND source_id = 'widen-order' AND event = 'OrderCancelled'`,
              )
              expect(yield* tagMismatches).toEqual([])

              return test.tenant
            }),
          ),
        )

        yield* environment.restart

        yield* Effect.promise(() =>
          run(
            environment,
            fixture,
            Effect.gen(function* () {
              const events = query(
                (sql) => sql<{ events: string }>`SELECT to_jsonb(events)::text AS events
                  FROM actor_subscriptions WHERE tenant_id = ${tenant}
                    AND source_id = 'widen-order' AND subscriber_id = 'widen-follower'`,
              )

              expect((yield* events)[0]!.events).toBe('["OrderCancelled", "OrderPlaced"]')
              expect(yield* tagMismatches).toEqual([])
              yield* Effect.gen(function* () {
                yield* (yield* SubOrder.get("widen-order")).CancelOrder("w")
              }).pipe(Effect.provideService(Tenant, tenant))
              yield* drain

              const { state } = yield* (yield* ActorTest).inspect({
                tenant,
                actor: "SubFollower",
                id: "widen-follower",
              })

              expect(state).toEqual({ log: ["widen-order#1:OrderCancelled"] })
            }),
          ),
        )
      }).pipe(Effect.runPromise),
  },
  {
    name: "never claims a row widened with a class this runner does not declare, and leaves it due",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          yield* (yield* SubFollower.get("older-follower")).Follow({ source: "older-order" })
          yield* drain
          yield* query(
            (sql) => sql`UPDATE actor_subscriptions
              SET events = ARRAY['OrderCancelled', 'OrderNoted', 'OrderPlaced']
              WHERE tenant_id = ${test.tenant} AND source_id = 'older-order'
                AND subscriber_id = 'older-follower'`,
          )
          yield* (yield* SubOrder.get("older-order")).Place({ customerId: "o", amount: 1 })
          yield* drain
          yield* test.advance(CLAIM_LEASE)

          expect(handlerRuns(fixture, "SubFollower/older-follower")).toBe(0)
          expect(yield* followerLog("older-follower")).toEqual([])
          expect(yield* sourceRows("older-order")).toMatchObject([
            {
              subscriber_id: "older-follower",
              active: true,
              delivered: "0",
              due: true,
              attempts: 0,
            },
          ])

          yield* query(
            (
              sql,
            ) => sql`UPDATE actor_subscriptions SET events = ARRAY['OrderCancelled', 'OrderPlaced']
              WHERE tenant_id = ${test.tenant} AND source_id = 'older-order'
                AND subscriber_id = 'older-follower'`,
          )
          yield* test.advance(CLAIM_LEASE)

          expect(yield* followerLog("older-follower")).toEqual(["older-order#1:OrderPlaced"])
          expect(yield* tagMismatches).toEqual([])
        }),
      ),
  },
  {
    name: "fails registration of a source served without a subscriber type that routes from it",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase

          const runtime = <A>(record: Effect.Effect<A, never, SqlClient.SqlClient>) =>
            Layer.build(
              Layer.fresh(subOrderLayer).pipe(
                Layer.provideMerge(
                  ActorTest.layer({ database, authorize: () => Effect.succeed(true) }),
                ),
              ),
            ).pipe(
              Effect.flatMap((context) => record.pipe(Effect.provideContext(context))),
              Effect.scoped,
              Effect.exit,
            )

          const alone = yield* runtime(
            query(
              (
                sql,
              ) => sql`INSERT INTO actor_routed_subscriptions (source_type, subscriber_type, subscription)
                VALUES ('SubOrder', 'SubSummary', 'CustomerOrders')`,
            ),
          )

          expect(Exit.isSuccess(alone)).toBe(true)

          const partial = yield* runtime(Effect.void)

          expect(
            Exit.isFailure(partial) &&
              Cause.pretty(partial.cause).includes(
                "Actor SubOrder is registered without the subscriber types that route from it",
              ),
          ).toBe(true)
        }),
      ),
    timeoutMs: 60_000,
  },
  {
    name: "keeps the tag summary equal to the rows after every insert, widen, and delete",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const followers = ["tags-a", "tags-b", "tags-c"]

          for (const id of followers)
            yield* (yield* SubFollower.get(id)).Follow({ source: "tags-order" })
          yield* drain
          expect(yield* tagMismatches).toEqual([])

          const counts = () =>
            query(
              (sql) => sql<{
                event: string
                rows: number
              }>`SELECT event, rows FROM actor_subscription_tags
                WHERE tenant_id = ${test.tenant} AND source_id = 'tags-order' ORDER BY event`,
            )

          expect(yield* counts()).toEqual([
            { event: "OrderCancelled", rows: 3 },
            { event: "OrderPlaced", rows: 3 },
          ])
          yield* (yield* SubFollower.get("tags-b")).Unfollow("tags-order")
          yield* drain
          expect(yield* counts()).toEqual([
            { event: "OrderCancelled", rows: 2 },
            { event: "OrderPlaced", rows: 2 },
          ])
          yield* (yield* SubOrder.get("tags-order")).Place({ customerId: "tags-x", amount: 1 })
          yield* drain
          expect(yield* counts()).toEqual([
            { event: "OrderCancelled", rows: 4 },
            { event: "OrderPlaced", rows: 5 },
          ])
          yield* (yield* SubFollower.get("tags-a")).Unfollow("tags-order")
          yield* (yield* SubFollower.get("tags-c")).Unfollow("tags-order")
          yield* drain
          expect(yield* counts()).toEqual([
            { event: "OrderCancelled", rows: 2 },
            { event: "OrderPlaced", rows: 3 },
          ])
          expect(yield* tagMismatches).toEqual([])
        }),
      ),
  },
]
