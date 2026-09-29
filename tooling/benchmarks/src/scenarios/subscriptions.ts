import { DateTime, Effect, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { load } from "../measure.ts"
import { Sender } from "../probe/contract.ts"
import {
  awaitApplied,
  BeatFollower,
  BeatSource,
  PoisonFollower,
  PruneSource,
  PulseSleeper,
  PulseSource,
} from "../probe/subscriptions.ts"
import { cleanup } from "@durable-actors/core/testing"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

/**
 * Gives `source` `rows` subscriptions of a subscriber type no runner
 * registers, so its commits pay the full publish path and the relay expands
 * its feed, but no delivery turn competes with the publisher being timed.
 */
const seedSubscriptions = Effect.fnUntraced(function* (
  source: string,
  rows: number,
  sourceType = "BeatSource",
) {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    WITH source AS (
      SELECT routing_key, tenant_id, event_sequence FROM actor_generations
      WHERE actor_type = ${sourceType} AND actor_id = ${source}),
    subscribed AS (
      INSERT INTO actor_subscriptions (routing_key, tenant_id, source_type, source_id,
        subscriber_type, subscription, subscriber_id, events, epoch, active, delivered, bucket)
      SELECT s.routing_key, s.tenant_id, ${sourceType}, ${source}, 'BeatRemote', 'Beats',
        'remote-' || n, ARRAY['Beat'], 1, true, s.event_sequence, (s.routing_key >> 56)::int
      FROM source s, generate_series(1, ${rows}) AS n
      RETURNING 1)
    INSERT INTO actor_subscription_tags (routing_key, tenant_id, source_type, source_id, event, rows)
    SELECT routing_key, tenant_id, ${sourceType}, ${source}, 'Beat', (SELECT count(*) FROM subscribed)
    FROM source`.pipe(Effect.orDie)
})

/** A one-shot case's rate: `events` over the whole case. */
const rate = (result: CaseResult, events: number): CaseResult => ({
  ...result,
  throughput: Math.round((events / (result.elapsedMs / 1000)) * 10) / 10,
  extra: { ...result.extra, events },
})

/**
 * Cross-actor subscriptions. The baseline stages one intent per
 * subscriber in the publisher's turn; a declared subscription keeps the
 * publisher's turn flat in subscriber count and fans out after commit.
 *
 * The retention pass beside a source's lagging subscriptions: each batch reads
 * the lowest settled position among them, and the hold has ended, so every
 * event is pruned either way.
 *
 * One source's backlog to 63 healthy followers, beside a 64th whose handler
 * always dies, against the same backlog without it: the poison row backs off
 * on its own and must not hold the others back.
 */
export const subscriptions: Scenario = {
  name: "subscriptions",
  description:
    "Cross-actor subscriptions: the hand-rolled intent fan-out baseline; the publisher's turn beside 1 to 1,024 subscriptions; commit-to-delivery latency, awake and hibernated; one pair's throughput; fan-in; subscribe churn; a backlog drain across 64 subscribers; the retention pass beside 10,000 subscriptions; and lag beside one poison row.",
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const results: Array<CaseResult> = []
      const dueAt = DateTime.toEpochMillis(yield* DateTime.now) + 86_400_000

      for (const subscribers of [1, 16, 256, 1024])
        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              const publisher = yield* Sender.get(`fanout-${subscribers}`)
              let next = 0

              const publish = () => {
                const offset = next
                next += subscribers

                return publisher.SendMany({ offset, count: subscribers, atMs: dueAt })
              }

              yield* load({ workers: 1, operations: 10, operation: publish })

              return yield* measure({
                name: `intent-fanout-${subscribers}`,
                parameters: { subscribers, publishers: 1, workers: 1 },
                instruments,
                workers: 1,
                operations: Math.max(
                  20,
                  Math.round((quick ? 20_000 : 200_000) / (subscribers + 99)),
                ),
                operation: publish,
                listStatements: true,
              })
            }),
          ),
        )

      for (const subscribers of [1, 16, 256, 1024])
        results.push(
          yield* context
            .withRuntime({ subscriptions: true }, (instruments) =>
              Effect.gen(function* () {
                const id = `publisher-${subscribers}`
                const publisher = yield* BeatSource.get(id)
                yield* publisher.Emit(0)
                yield* seedSubscriptions(id, subscribers)
                let next = 1
                const publish = () => publisher.Emit(next++)

                yield* load({ workers: 1, operations: 50, operation: publish })

                return yield* measure({
                  name: `publish-with-${subscribers}-subscribers`,
                  parameters: { subscribers, publishers: 1, workers: 1 },
                  instruments,
                  workers: 1,
                  operations: quick ? 300 : 2000,
                  operation: publish,
                  listStatements: true,
                })
              }),
            )
            .pipe(Effect.orDie),
        )

      results.push(
        yield* context
          .withRuntime({ subscriptions: true }, (instruments) =>
            Effect.gen(function* () {
              const source = yield* PulseSource.get("latency")
              let next = 0

              const trip = () =>
                Effect.gen(function* () {
                  const key = `pulse-${next++}`
                  const applied = yield* awaitApplied(key)
                  yield* source.Pulse({ reader: "latency-reader", key })
                  yield* applied
                })

              yield* load({ workers: 1, operations: 20, operation: trip })

              return yield* measure({
                name: "commit-to-delivery",
                parameters: { subscribers: 1, route: "id", workers: 1 },
                instruments,
                workers: 1,
                operations: quick ? 100 : 1000,
                operation: trip,
                listStatements: true,
              })
            }),
          )
          .pipe(Effect.orDie),
      )

      results.push(
        yield* context
          .withRuntime({ subscriptions: true }, (instruments) =>
            Effect.gen(function* () {
              const operations = quick ? 50 : 300
              const source = yield* PulseSource.get("hibernated-latency")

              yield* Effect.forEach(
                Array.from({ length: operations + 10 }, (_, index) => index),
                (index) =>
                  Effect.flatMap(PulseSleeper.get(`sleeper-${index}`), (sleeper) =>
                    sleeper.Touch(),
                  ),
                { concurrency: 16, discard: true },
              )
              yield* Effect.sleep("1 second")

              const trip = (index: number) =>
                Effect.gen(function* () {
                  const key = `hibernated-${index}`
                  const applied = yield* awaitApplied(key)
                  yield* source.Pulse({ reader: `sleeper-${index}`, key })
                  yield* applied
                })

              yield* load({
                workers: 1,
                operations: 10,
                operation: (index) => trip(operations + index),
              })

              return yield* measure({
                name: "commit-to-delivery-hibernated",
                parameters: {
                  subscribers: operations,
                  route: "id",
                  workers: 1,
                  hibernateAfterMs: 100,
                },
                instruments,
                workers: 1,
                operations,
                operation: trip,
                listStatements: true,
              })
            }),
          )
          .pipe(Effect.orDie),
      )

      results.push(
        yield* context
          .withRuntime({ subscriptions: true }, (instruments) =>
            Effect.gen(function* () {
              const events = quick ? 200 : 2000
              const follower = yield* BeatFollower.get("pair-follower")
              const source = yield* BeatSource.get("pair-source")
              yield* follower.Follow("pair-source")
              let n = 0

              while (true) {
                const first = yield* awaitApplied(`pair-follower/${n}`)
                yield* source.Emit(n++)
                const done = yield* first.pipe(Effect.timeout("2 seconds"), Effect.option)

                if (Option.isSome(done)) break
              }

              const burst = () =>
                Effect.gen(function* () {
                  const last = n + events - 1
                  const applied = yield* awaitApplied(`pair-follower/${last}`)

                  for (let index = 0; index < events; index++) yield* source.Emit(n++)
                  yield* applied
                })

              return rate(
                yield* measure({
                  name: "pair-throughput",
                  parameters: { sources: 1, subscribers: 1, events },
                  instruments,
                  workers: 1,
                  operations: 1,
                  operation: burst,
                }),
                events,
              )
            }),
          )
          .pipe(Effect.orDie),
      )

      for (const sources of [quick ? 1000 : 10_000])
        results.push(
          yield* context
            .withRuntime({ subscriptions: true, maxConnections: 20 }, (instruments) =>
              Effect.gen(function* () {
                const pulse = (phase: string) => (index: number) =>
                  Effect.gen(function* () {
                    const key = `${phase}-${index}`
                    const applied = yield* awaitApplied(key)
                    yield* (yield* PulseSource.get(`fan-in-${phase}-${index}`)).Pulse({
                      reader: "fan-in-reader",
                      key,
                    })
                    yield* applied
                  })

                yield* load({ workers: 16, operations: 64, operation: pulse("warm") })

                return rate(
                  yield* measure({
                    name: `fan-in-${sources}`,
                    parameters: { sources, subscribers: 1, workers: 64 },
                    instruments,
                    workers: 64,
                    operations: sources,
                    operation: pulse("measured"),
                  }),
                  sources,
                )
              }),
            )
            .pipe(Effect.orDie),
        )

      results.push(
        yield* context
          .withRuntime({ subscriptions: true }, (instruments) =>
            Effect.gen(function* () {
              const follower = yield* BeatFollower.get("churn-follower")
              let next = 0

              const churn = () =>
                Effect.suspend(() =>
                  next++ % 2 === 0
                    ? follower.Follow("churn-source")
                    : follower.Unfollow("churn-source"),
                )

              yield* load({ workers: 1, operations: 20, operation: churn })

              return yield* measure({
                name: "subscribe-churn",
                parameters: { subscribers: 1, sources: 1, workers: 1 },
                instruments,
                workers: 1,
                operations: quick ? 200 : 2000,
                operation: churn,
                listStatements: true,
              })
            }),
          )
          .pipe(Effect.orDie),
      )

      for (const backlog of [quick ? 1024 : 8192])
        results.push(
          yield* context
            .withRuntime({ subscriptions: true }, (instruments) =>
              Effect.gen(function* () {
                const followers = 64
                const perFollower = backlog / followers
                const source = yield* BeatSource.get(`drain-source-${backlog}`)

                for (let index = 0; index < followers; index++)
                  yield* (yield* BeatFollower.get(`drain-${index}`)).Follow(
                    `drain-source-${backlog}`,
                  )

                const sql = yield* SqlClient.SqlClient

                while (
                  (yield* sql<{
                    rows: number
                  }>`SELECT count(*)::int AS rows FROM actor_subscriptions
                  WHERE source_id = ${`drain-source-${backlog}`} AND active`.pipe(Effect.orDie))[0]!
                    .rows < followers
                )
                  yield* Effect.sleep("20 millis")

                const drain = () =>
                  Effect.gen(function* () {
                    const applied = yield* Effect.forEach(
                      Array.from({ length: followers }, (_, index) => index),
                      (index) => awaitApplied(`drain-${index}/${perFollower - 1}`),
                    )

                    for (let n = 0; n < perFollower; n++) yield* source.Emit(n)
                    yield* Effect.all(applied, { concurrency: "unbounded", discard: true })
                  })

                return rate(
                  yield* measure({
                    name: `drain-${backlog}`,
                    parameters: { backlog, subscribers: followers, sources: 1 },
                    instruments,
                    workers: 1,
                    operations: 1,
                    operation: drain,
                  }),
                  backlog,
                )
              }),
            )
            .pipe(Effect.orDie),
        )

      for (const rows of [0, 10_000])
        results.push(
          yield* context
            .withRuntime({ subscriptions: true }, (instruments) =>
              Effect.gen(function* () {
                const events = quick ? 1000 : 10_000
                const source = yield* PruneSource.get("pruned")
                yield* source.EmitMany(1)

                if (rows > 0) yield* seedSubscriptions("pruned", rows, "PruneSource")

                for (let emitted = 0; emitted < events; emitted += 1000)
                  yield* source.EmitMany(1000)

                yield* Effect.sleep("2500 millis")

                return rate(
                  yield* measure({
                    name: `prune-beside-${rows}-subscriptions`,
                    parameters: { subscriptions: rows, events },
                    instruments,
                    workers: 1,
                    operations: 1,
                    operation: () => cleanup,
                  }),
                  events,
                )
              }),
            )
            .pipe(Effect.orDie),
        )

      for (const poison of [false, true])
        results.push(
          yield* context
            .withRuntime({ subscriptions: true }, (instruments) =>
              Effect.gen(function* () {
                const followers = 63
                const perFollower = quick ? 16 : 128
                const name = poison ? "lag-with-one-poison-row" : "lag-without-poison-row"
                const source = yield* BeatSource.get(name)

                for (let index = 0; index < followers; index++)
                  yield* (yield* BeatFollower.get(`${name}-${index}`)).Follow(name)

                if (poison) yield* (yield* PoisonFollower.get(`${name}-poison`)).Follow(name)

                const sql = yield* SqlClient.SqlClient
                const expected = followers + (poison ? 1 : 0)

                while (
                  (yield* sql<{
                    rows: number
                  }>`SELECT count(*)::int AS rows FROM actor_subscriptions
                  WHERE source_id = ${name} AND active`.pipe(Effect.orDie))[0]!.rows < expected
                )
                  yield* Effect.sleep("20 millis")

                const lag = () =>
                  Effect.gen(function* () {
                    const applied = yield* Effect.forEach(
                      Array.from({ length: followers }, (_, index) => index),
                      (index) => awaitApplied(`${name}-${index}/${perFollower - 1}`),
                    )

                    for (let n = 0; n < perFollower; n++) yield* source.Emit(n)
                    yield* Effect.all(applied, { concurrency: "unbounded", discard: true })
                  })

                return rate(
                  yield* measure({
                    name,
                    parameters: { subscribers: followers, poison, events: perFollower, sources: 1 },
                    instruments,
                    workers: 1,
                    operations: 1,
                    operation: lag,
                  }),
                  perFollower * followers,
                )
              }),
            )
            .pipe(Effect.orDie),
        )

      return results
    }),
}
