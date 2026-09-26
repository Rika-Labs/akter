import { cleanup } from "durable-actors/testing"
import { Effect, Fiber } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { load, now } from "../measure.ts"
import { EventProbe, Probe, RetentionProbe } from "../probe/contract.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

/** Actors the seeded backlog is spread over. */
const ACTORS = 1000

const perSecond = (count: number, elapsedMs: number) =>
  elapsedMs === 0 ? 0 : Math.round((count / elapsedMs) * 1000)

/**
 * Seeds `rows` receipts and `rows` events past every horizon, spread over
 * `ACTORS` RetentionProbe actors whose generation rows real turns created.
 * The rows go in with SQL: a million turns would take the whole run. Ages
 * rise with each actor's sequence, as they would have when the rows were written.
 */
const seed = Effect.fnUntraced(function* (rows: number) {
  const sql = yield* SqlClient.SqlClient

  yield* load({
    workers: 16,
    operations: ACTORS,
    operation: (actor) =>
      RetentionProbe.get(`retained-${actor}`).pipe(Effect.flatMap((probe) => probe.Emit(0))),
  })

  const perActor = Math.ceil(rows / ACTORS)

  yield* sql`INSERT INTO actor_receipts (routing_key, tenant_id, actor_type, actor_id, command_id,
      command, payload_hash, caller_key, outcome, expires_at_ms)
    SELECT g.routing_key, g.tenant_id, g.actor_type, g.actor_id, 'v1.0.1.seed-' || s,
      'Emit', 'seed', '["Anonymous"]', '{"_tag":"Success","value":"{}"}', s
    FROM actor_generations g, generate_series(1, ${perActor}) AS s
    WHERE g.actor_type = 'RetentionProbe'`

  yield* sql`INSERT INTO actor_events (routing_key, tenant_id, actor_type, actor_id, sequence,
      event, command_id, value, emitted_at_ms)
    SELECT g.routing_key, g.tenant_id, g.actor_type, g.actor_id, s, 'Ticked', 'seed', '\\x00'::bytea, s
    FROM actor_generations g, generate_series(1, ${perActor}) AS s
    WHERE g.actor_type = 'RetentionProbe'`

  yield* sql`UPDATE actor_generations SET event_sequence = ${perActor}
    WHERE actor_type = 'RetentionProbe'`
  yield* sql`ANALYZE actor_receipts`
  yield* sql`ANALYZE actor_events`

  return perActor * ACTORS
}, Effect.orDie)

/**
 * Cleanup throughput over a backlog of old receipts and events, the warm-turn
 * tail while a sweep runs against the same idle-run tail, and the latency of
 * one replay page.
 */
export const retention: Scenario = {
  name: "retention",
  description:
    "One cleanup sweep over 10^6 (quick: 10^5) old receipts and events; warm turns while a sweep runs against an idle run; one replay page of 100 and 1,000 events.",
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const rows = quick ? 100_000 : 1_000_000
      const results: Array<CaseResult> = []

      results.push(
        yield* context.withRuntime({}, (instruments) =>
          Effect.gen(function* () {
            const seeded = yield* seed(rows)
            let swept = { receipts: 0, events: 0 }

            const result = yield* measure({
              name: `sweep-${seeded}`,
              parameters: { receipts: seeded, events: seeded, actors: ACTORS, workers: 1 },
              instruments,
              workers: 1,
              operations: 1,
              operation: () =>
                cleanup.pipe(
                  Effect.tap((done) =>
                    Effect.sync(() => {
                      swept = done
                    }),
                  ),
                ),
            })

            return {
              ...result,
              extra: {
                receiptsSwept: swept.receipts,
                eventsSwept: swept.events,
                rowsPerSecond: perSecond(swept.receipts + swept.events, result.elapsedMs),
              },
            }
          }),
        ),
      )

      const windowMs = quick ? 1000 : 5000

      results.push(
        ...(yield* context.withRuntime({}, (instruments) =>
          Effect.gen(function* () {
            const probe = yield* Probe.get("warm")
            yield* load({ workers: 1, operations: 200, operation: () => probe.Add(1) })
            const seeded = yield* seed(rows)

            const idle = yield* measure({
              name: "turn-idle",
              parameters: { backlog: seeded, workers: 1 },
              instruments,
              workers: 1,
              durationMs: windowMs,
              operation: () => probe.Add(1),
            })

            const started = yield* now
            const sweeping = yield* cleanup.pipe(Effect.forkChild)

            const during = yield* measure({
              name: "turn-during-sweep",
              parameters: { backlog: seeded, workers: 1 },
              instruments,
              workers: 1,
              durationMs: windowMs,
              operation: () => probe.Add(1),
            })

            // The comparison holds only if the sweep outlasted the window.
            const stillSweeping = sweeping.pollUnsafe() === undefined
            yield* Fiber.join(sweeping)

            return [
              idle,
              {
                ...during,
                extra: {
                  p99RatioToIdle:
                    Math.round((during.latencyMs.p99 / idle.latencyMs.p99) * 100) / 100,
                  sweepOutlastedWindow: stillSweeping ? 1 : 0,
                  sweepMs: Math.round((yield* now) - started),
                },
              },
            ]
          }),
        )),
      )

      results.push(
        ...(yield* context.withRuntime({}, (instruments) =>
          Effect.gen(function* () {
            const probe = yield* EventProbe.get("paged")
            yield* load({ workers: 1, operations: 100, operation: () => probe.Emit(100) })
            const pages: Array<CaseResult> = []

            for (const limit of [100, 1000])
              pages.push(
                yield* measure({
                  name: `replay-page-${limit}-of-10000`,
                  parameters: { streamEvents: 10_000, pageEvents: limit, workers: 1 },
                  instruments,
                  workers: 1,
                  operations: quick ? 100 : 1000,
                  operation: (index) =>
                    probe.ReplayPage({ after: String((index * limit) % 9000), limit }),
                }),
              )

            return pages
          }),
        )),
      )

      return results
    }),
}
