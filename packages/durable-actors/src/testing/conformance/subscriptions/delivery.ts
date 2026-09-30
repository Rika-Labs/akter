import { Effect, Schema } from "effect"
import { User } from "../../../index.ts"
import {
  InternalActors,
  Outcome,
  Request,
  type SubscriptionEnvelope,
} from "../../../handles/actors.ts"
import { InternalCommandId } from "../../../identity/command.ts"
import { deliveryCommandId } from "../../../runtime/subscriptions/identity.ts"
import { ActorTest, executeForTest } from "../../actor-test.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { CLAIM_LEASE } from "../outbox.ts"
import { Refused, SubFollower, SubGated, SubGateOrder, SubOrder } from "./actors.ts"
import {
  crashOnce,
  cursorRows,
  deliveryRequest,
  drain,
  followerLog,
  handlerRuns,
  logOf,
  outboxOf,
  query,
  run,
  sourceRows,
  subscriber,
} from "./harness.ts"

/** Exactly-once delivery, receipts, and derived command ids of event subscriptions. */
export const subscriptionDeliveryConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "acknowledges a redelivery whose receipt was pruned without running the handler",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          yield* (yield* SubFollower.get("pruned-follower")).Follow({ source: "pruned-order" })
          yield* drain
          crashOnce(fixture, "beforeSettle", subscriber("pruned-follower"))
          yield* (yield* SubOrder.get("pruned-order")).Place({ customerId: "p", amount: 1 })
          yield* drain
          expect(handlerRuns(fixture, "SubFollower/pruned-follower")).toBe(1)
          expect(yield* sourceRows("pruned-order")).toMatchObject([{ delivered: "0" }])

          yield* query(
            (sql) => sql`DELETE FROM actor_receipts WHERE tenant_id = ${test.tenant}
              AND actor_type = 'SubFollower' AND actor_id = 'pruned-follower' AND command = 'OnOrder'`,
          )
          yield* test.advance(CLAIM_LEASE)

          expect(handlerRuns(fixture, "SubFollower/pruned-follower")).toBe(1)
          expect(yield* followerLog("pruned-follower")).toEqual(["pruned-order#1:OrderPlaced"])
          expect(yield* sourceRows("pruned-order")).toMatchObject([{ delivered: "1", due: false }])
        }),
      ),
  },
  {
    name: "applies each committed source event once when the relay dies before and after the subscriber's commit",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const order = yield* SubOrder.get("crash-order")
          yield* (yield* SubFollower.get("crash-follower")).Follow({ source: "crash-order" })
          yield* drain

          const commit = crashOnce(fixture, "beforeCommit", subscriber("crash-follower"))
          yield* order.Place({ customerId: "c", amount: 1 })
          yield* drain
          expect(commit.crashed).toBe(true)
          const settle = crashOnce(fixture, "beforeSettle", subscriber("crash-follower"))
          yield* order.Place({ customerId: "c", amount: 2 })
          yield* drain
          expect(settle.crashed).toBe(true)
          yield* test.advance(CLAIM_LEASE)
          yield* test.advance(CLAIM_LEASE)

          expect(yield* followerLog("crash-follower")).toEqual([
            "crash-order#1:OrderPlaced",
            "crash-order#2:OrderPlaced",
          ])
          expect(
            yield* test.receiptsFor(
              { tenant: test.tenant, actor: "SubFollower", id: "crash-follower" },
              "OnOrder",
            ),
          ).toBe(2)
        }),
      ),
  },
  {
    name: "acknowledges a stale routed delivery as AlreadyApplied after a NotCreated skip and a later creation",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const internal = yield* InternalActors
          const order = yield* SubGateOrder.get("gate-order")
          yield* order.Place({ customerId: "gate-sub", amount: 1 })
          yield* drain

          expect(handlerRuns(fixture, "SubGated/gate-sub")).toBe(0)
          expect(yield* cursorRows("SubGated", "gate-sub")).toMatchObject([
            { subscription: "GatedOrders", source_id: "gate-order", applied: "1" },
          ])

          yield* (yield* SubGated.get("gate-sub")).OpenGated()
          yield* query(
            (sql) => sql`DELETE FROM actor_receipts WHERE tenant_id = ${test.tenant}
              AND actor_type = 'SubGated' AND actor_id = 'gate-sub' AND command = 'OnGated'`,
          )

          const stale = yield* deliveryRequest({
            subscriber: "gate-sub",
            source: "gate-order",
            epoch: "0",
            cursor: "1",
            route: {
              actor: "SubGated",
              subscription: "GatedOrders",
              command: "OnGated",
              source: "SubGateOrder",
            },
          })

          expect(yield* internal.deliver(stale)).toEqual(
            Outcome.cases.Acknowledged.make({ reason: "AlreadyApplied" }),
          )
          expect(handlerRuns(fixture, "SubGated/gate-sub")).toBe(0)

          yield* order.Place({ customerId: "gate-sub", amount: 2 })
          yield* drain

          expect(yield* logOf("SubGated", "gate-sub")).toEqual(["gate-order#2:OrderPlaced"])
        }),
      ),
  },
  {
    name: "refuses a stale runner's delivery below the applied cursor after a lease takeover",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const internal = yield* InternalActors
          yield* (yield* SubFollower.get("stale-follower")).Follow({ source: "stale-order" })
          yield* drain
          yield* (yield* SubOrder.get("stale-order")).PlaceMany({ customerId: "s", count: 2 })
          yield* drain
          yield* query(
            (sql) => sql`DELETE FROM actor_receipts WHERE tenant_id = ${test.tenant}
              AND actor_type = 'SubFollower' AND actor_id = 'stale-follower'`,
          )

          const stale = yield* deliveryRequest({
            subscriber: "stale-follower",
            source: "stale-order",
            epoch: "1",
            cursor: "1",
          })

          expect(yield* internal.deliver(stale)).toEqual(
            Outcome.cases.Acknowledged.make({ reason: "AlreadyApplied" }),
          )

          const older = yield* deliveryRequest({
            subscriber: "stale-follower",
            source: "stale-order",
            epoch: "0",
            cursor: "2",
          })

          expect(yield* internal.deliver(older)).toEqual(
            Outcome.cases.Acknowledged.make({ reason: "Stale" }),
          )
          expect(handlerRuns(fixture, "SubFollower/stale-follower")).toBe(2)
        }),
      ),
  },
  {
    name: "advances past a declared failure and replays its receipt",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const internal = yield* InternalActors
          yield* (yield* SubFollower.get("declared-follower")).Follow({ source: "declared-order" })
          yield* drain
          fixture.behave = (entry) => (entry.endsWith("#1:OrderPlaced") ? "refuse" : "apply")
          yield* (yield* SubOrder.get("declared-order")).PlaceMany({ customerId: "d", count: 2 })
          yield* drain

          expect(yield* followerLog("declared-follower")).toEqual(["declared-order#2:OrderPlaced"])
          expect(yield* cursorRows("SubFollower", "declared-follower")).toMatchObject([
            { applied: "2" },
          ])

          const replay = yield* internal.deliver(
            yield* deliveryRequest({
              subscriber: "declared-follower",
              source: "declared-order",
              epoch: "1",
              cursor: "1",
            }),
          )

          expect(Outcome.guards.Failure(replay)).toBe(true)
          expect(handlerRuns(fixture, "SubFollower/declared-follower")).toBe(2)
        }),
      ),
  },
  {
    name: "replays after a schema-compatible deploy instead of CommandConflict",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const internal = yield* InternalActors
          yield* (yield* SubFollower.get("deploy-follower")).Follow({ source: "deploy-order" })
          yield* drain
          yield* (yield* SubOrder.get("deploy-order")).Place({ customerId: "d", amount: 1 })
          yield* drain

          const redelivered = yield* deliveryRequest({
            subscriber: "deploy-follower",
            source: "deploy-order",
            epoch: "1",
            cursor: "1",
            extra: true,
          })

          expect(Outcome.guards.Success(yield* internal.deliver(redelivered))).toBe(true)
          expect(handlerRuns(fixture, "SubFollower/deploy-follower")).toBe(1)
        }),
      ),
  },
  {
    name: "derives distinct command ids for two subscriptions, two subscribers, and two epochs of one source",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const subscriber = { tenant: "t", actor: "SubFollower", id: "a" }

          const envelope: SubscriptionEnvelope = {
            subscription: "FollowedOrders",
            sourceType: "SubOrder",
            sourceId: "o",
            epoch: "1",
            kind: "event",
            position: "1",
          }

          const ids = yield* Effect.forEach(
            [
              [subscriber, envelope],
              [subscriber, { ...envelope, subscription: "Other" }],
              [{ ...subscriber, id: "b" }, envelope],
              [subscriber, { ...envelope, epoch: "2" }],
              [subscriber, { ...envelope, kind: "gap" as const }],
            ] as const,
            ([ref, env]) =>
              deliveryCommandId({
                subscriber: ref,
                envelope: env,
                issuedAt: 1_000,
                retryWindowMs: 60_000,
              }),
          )

          expect(new Set(ids).size).toBe(ids.length)
          expect(
            yield* deliveryCommandId({
              subscriber,
              envelope,
              issuedAt: 1_000,
              retryWindowMs: 60_000,
            }),
          ).toBe(ids[0])

          for (const id of ids) {
            expect(Schema.is(InternalCommandId)(id)).toBe(true)
            expect(id.startsWith("v1.1000.61000.")).toBe(true)
            expect(id.split(".")[3]![14]).toBe("8")
          }
        }),
      ),
  },
  {
    name: "accepts a version-8 derived id on System delivery and rejects it at external admission",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          yield* (yield* SubFollower.get("external-follower")).Follow({ source: "external-order" })
          yield* drain
          yield* (yield* SubOrder.get("external-order")).Place({ customerId: "e", amount: 1 })
          yield* drain
          expect(handlerRuns(fixture, "SubFollower/external-follower")).toBe(1)

          const delivery = yield* deliveryRequest({
            subscriber: "external-follower",
            source: "external-order",
            epoch: "1",
            cursor: "1",
          })

          const withEnvelope = yield* executeForTest(delivery).pipe(Effect.flip)
          expect(withEnvelope.reason._tag).toBe("Unauthorized")

          const { delivery: _, ...bare } = delivery
          const withCaller = yield* executeForTest(Request.make(bare)).pipe(Effect.flip)
          expect(withCaller.reason._tag).toBe("Unauthorized")

          const asUser = yield* executeForTest(
            Request.make({
              ...bare,
              ref: { ...bare.ref, actor: "SubFollower" },
              caller: User.make({ subject: "alice" }),
              command: "Touch",
              payload: "{}",
            }),
          ).pipe(Effect.flip)

          expect(asUser.reason._tag).toBe("InvalidCommandId")
          expect(handlerRuns(fixture, "SubFollower/external-follower")).toBe(1)
        }),
      ),
  },
  {
    name: "delivers nothing for a rolled-back source turn",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          yield* (yield* SubFollower.get("rollback-follower")).Follow({ source: "rollback-order" })
          yield* drain
          const order = yield* SubOrder.get("rollback-order")
          expect(yield* order.PlaceThenRefuse("rb").pipe(Effect.flip)).toBeInstanceOf(Refused)
          yield* order.PlaceThenDie("rb").pipe(Effect.exit)
          yield* drain

          expect(yield* outboxOf("SubOrder", "rollback-order", "feed")).toBe(0)
          expect(yield* followerLog("rollback-follower")).toEqual([])
          expect(yield* logOf("SubSummary", "rb")).toEqual([])
          expect(handlerRuns(fixture, "SubFollower/rollback-follower")).toBe(0)
        }),
      ),
  },
]
