import { Effect, Stream } from "effect"
import { ActorTest } from "../../actor-test.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { CLAIM_LEASE } from "../outbox.ts"
import { Live, ShipOrder, SubFollower, SubJournal, SubOrder, SubShipment } from "./actors.ts"
import { crashOnce, drain, followerLog, logOf, query, run, subscriber } from "./harness.ts"

const journalRow = (source: string, subscriberType: string) =>
  Effect.gen(function* () {
    const test = yield* ActorTest

    return (yield* query(
      (sql) => sql<{ delivered: string; gaps: string; gap_through: string | null }>`
        SELECT delivered::text AS delivered, gaps::text AS gaps, gap_through::text AS gap_through
        FROM actor_subscriptions WHERE tenant_id = ${test.tenant} AND source_type = 'SubJournal'
          AND source_id = ${source} AND subscriber_type = ${subscriberType}`,
    ))[0]
  })

const journalEvents = (source: string) =>
  ActorTest.use((test) =>
    test
      .inspect({ tenant: test.tenant, actor: "SubJournal", id: source })
      .pipe(Effect.map((inspection) => inspection.events)),
  )

/** Wake, retention holds, gaps, broadcasts, and workflow waits. */
export const subscriptionsRetentionConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "keeps events above the lowest subscriber cursor inside the hold, then prunes past it and delivers one RetentionGap, then resumes",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const journal = yield* SubJournal.get("hold-j")
          yield* (yield* SubFollower.get("hold-f")).FollowJournal({ source: "hold-j" })
          yield* drain
          fixture.behave = (entry) => (entry.startsWith("SubFollower/hold-f/") ? "defect" : "apply")
          yield* journal.Record({ customerId: "hold-c", count: 3 })
          yield* drain

          yield* test.advance("90 minutes")
          yield* test.cleanup
          expect(yield* journalEvents("hold-j")).toBe(3)

          yield* test.advance("40 minutes")
          yield* test.cleanup
          expect(yield* journalEvents("hold-j")).toBe(0)

          fixture.behave = () => "apply"
          yield* journal.Record({ customerId: "hold-c", count: 1 })
          yield* test.advance("300 seconds")

          expect(yield* followerLog("hold-f")).toEqual(["hold-j~gap:0-3", "hold-j#4:OrderPlaced"])
          expect(yield* journalRow("hold-j", "SubFollower")).toMatchObject({
            delivered: "4",
            gap_through: null,
          })
        }),
      ),
  },
  {
    name: 'reports RetentionGap first for a from: "start" subscription after pruning',
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const journal = yield* SubJournal.get("pruned-j")
          yield* journal.Record({ customerId: "pruned-c", count: 2 })
          yield* drain
          yield* test.advance("3 hours")
          yield* test.cleanup
          yield* journal.Record({ customerId: "pruned-c", count: 1 })
          yield* (yield* SubFollower.get("pruned-jf")).FollowJournal({
            source: "pruned-j",
            from: "start",
          })
          yield* drain

          expect(yield* followerLog("pruned-jf")).toEqual([
            "pruned-j~gap:0-2",
            "pruned-j#3:OrderPlaced",
          ])
        }),
      ),
  },
  {
    name: "counts an id-routed gap on the row and delivers a singleton-routed gap",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const journal = yield* SubJournal.get("routegap-j")
          fixture.behave = (entry) => (entry.includes("/routegap-j#") ? "defect" : "apply")
          yield* journal.Record({ customerId: "routegap-c", count: 2 })
          yield* drain
          yield* test.advance("3 hours")
          yield* test.cleanup
          expect(yield* journalEvents("routegap-j")).toBe(0)

          fixture.behave = () => "apply"
          yield* journal.Record({ customerId: "routegap-c", count: 1 })
          yield* test.advance("300 seconds")

          expect(yield* logOf("SubSummary", "routegap-c")).toEqual(["routegap-j#3:OrderPlaced"])
          expect(yield* journalRow("routegap-j", "SubSummary")).toMatchObject({
            gaps: "1",
            delivered: "3",
          })
          expect(
            (yield* logOf("SubDashboard", "singleton")).filter((entry) =>
              entry.startsWith("routegap-j"),
            ),
          ).toEqual(["routegap-j~gap:0-2", "routegap-j#3:OrderPlaced"])
          expect(yield* journalRow("routegap-j", "SubDashboard")).toMatchObject({ gaps: "0" })
        }),
      ),
  },
  {
    name: "repeats a gap's id and range on redelivery after pruning advances",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const journal = yield* SubJournal.get("repeat-j")
          yield* (yield* SubFollower.get("repeat-f")).FollowJournal({ source: "repeat-j" })
          yield* drain
          fixture.behave = (entry) =>
            entry.startsWith("SubFollower/repeat-f/") ? "defect" : "apply"
          yield* journal.Record({ customerId: "repeat-c", count: 2 })
          yield* drain
          yield* test.advance("3 hours")
          yield* test.cleanup

          fixture.behave = () => "apply"
          const settle = crashOnce(fixture, "beforeSettle", subscriber("repeat-f"))
          yield* journal.Record({ customerId: "repeat-c", count: 1 })
          yield* test.advance("300 seconds")
          expect(settle.crashed).toBe(true)
          expect(yield* journalRow("repeat-j", "SubFollower")).toMatchObject({
            delivered: "0",
            gap_through: "2",
          })

          yield* test.advance("3 hours")
          yield* test.cleanup
          expect(yield* journalEvents("repeat-j")).toBe(0)
          yield* test.advance(CLAIM_LEASE)
          yield* test.advance("300 seconds")

          expect(yield* followerLog("repeat-f")).toEqual([
            "repeat-j~gap:0-2",
            "repeat-j#3:OrderPlaced",
          ])

          for (const entry of ["repeat-j~gap:0-2", "repeat-j#3:OrderPlaced"])
            expect(
              fixture.runs.filter((run) => run === `SubFollower/repeat-f/${entry}`).length,
            ).toBe(1)
          expect(yield* journalRow("repeat-j", "SubFollower")).toMatchObject({
            delivered: "3",
            gap_through: null,
          })
        }),
      ),
  },
  {
    name: "wakes a hibernated subscriber and commits the delivery",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          yield* (yield* SubFollower.get("sleepy-f")).Follow({ source: "sleepy-o" })
          yield* drain
          yield* test.hibernate({ tenant: test.tenant, actor: "SubFollower", id: "sleepy-f" })
          yield* (yield* SubOrder.get("sleepy-o")).Place({ customerId: "s", amount: 1 })
          yield* drain

          expect(yield* followerLog("sleepy-f")).toEqual(["sleepy-o#1:OrderPlaced"])
        }),
      ),
  },
  {
    name: "flushes a delivery's broadcast to the parked subscriber's connection after commit, and discards it on declared failure",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const ref = { tenant: test.tenant, actor: "SubSummary", id: "live-c" }
          const connection = yield* test.connect(ref, Live, undefined)
          yield* test.hibernate(ref)
          fixture.behave = (entry) => (entry.includes("live-o#1:") ? "refuse" : "apply")
          const order = yield* SubOrder.get("live-o")
          yield* order.Place({ customerId: "live-c", amount: 1 })
          yield* order.Place({ customerId: "live-c", amount: 2 })
          yield* drain

          const frames = yield* connection.frames.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.timeout("10 seconds"),
          )

          expect(Array.from(frames)).toEqual(["live-o#2:OrderPlaced"])
          expect(yield* logOf("SubSummary", "live-c")).toEqual(["live-o#2:OrderPlaced"])
          yield* connection.close
        }),
      ),
  },
  {
    name: "resolves an owner wait from a subscription delivery that re-emits",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const shipment = yield* SubShipment.get("wf-ship")
          const execution = yield* shipment.PlaceOrder("wf-order")
          const workflow = yield* SubShipment.run(ShipOrder, execution)
          yield* drain
          yield* (yield* SubOrder.get("wf-order")).Place({ customerId: "wf", amount: 1 })
          yield* drain

          expect(yield* workflow.result.pipe(Effect.timeout("20 seconds"))).toBe("paid")
        }),
      ),
  },
  {
    name: "subscribes in the workflow's start turn and delivers after the start commits",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          yield* (yield* SubOrder.get("wf-early")).Place({ customerId: "wf", amount: 1 })
          const shipment = yield* SubShipment.get("wf-early-ship")
          const execution = yield* shipment.PlaceOrder("wf-early")
          const workflow = yield* SubShipment.run(ShipOrder, execution)
          yield* drain

          expect(yield* workflow.result.pipe(Effect.timeout("20 seconds"))).toBe("paid")
        }),
      ),
  },
]
