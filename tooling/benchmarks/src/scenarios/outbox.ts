import { Deferred, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Sender } from "../probe/contract.ts"
import { deliveries } from "../probe/layer.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

const databaseNow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const [row] = yield* sql<{
    readonly now: string
  }>`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now`

  return Number(row!.now)
}).pipe(Effect.orDie)

/** Registers `id` so the sink's handler can report its delivery; returns the wait for it. */
const expect = (id: string) =>
  Deferred.make<void>().pipe(
    Effect.tap((delivered) => Effect.sync(() => deliveries.set(id, delivered))),
    Effect.map((delivered) =>
      Deferred.await(delivered).pipe(Effect.ensuring(Effect.sync(() => deliveries.delete(id)))),
    ),
  )

/**
 * Sleeping actors, each holding one timer due in a day, spread over every
 * relay bucket the way `routing_key` spreads real actors.
 */
const seedSleepers = Effect.fnUntraced(function* (count: number, dueAt: number) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
    SELECT ((i % 256) - 128)::bigint << 56 | i, 'sleepers', 'Sleeper', i::text
    FROM generate_series(1, ${count}::int) AS i`
  yield* sql`INSERT INTO actor_outbox (routing_key, intent_id, bucket, due_at_ms,
      scheduled_at_ms, tenant_id, actor_type, actor_id, target_type, target_id, command, payload,
      caller)
    SELECT ((i % 256) - 128)::bigint << 56 | i, 'sleep-' || i, (i % 256) - 128, ${dueAt}::bigint,
      ${dueAt}::bigint, 'sleepers', 'Sleeper', i::text, 'Sleeper', i::text, 'Wake', '{}', '{}'
    FROM generate_series(1, ${count}::int) AS i`
  yield* sql`ANALYZE actor_outbox`
}, Effect.orDie)

const scanMeanMs = (result: CaseResult) =>
  result.statements?.find((statement) => statement.query.includes("generate_series"))?.meanMs

/**
 * The outbox relay: delivery latency of one intent from the sender's call to
 * the receiver's handler, drain throughput of a backlog that falls due at
 * once, and delivery latency with many sleeping timers that are not due.
 */
export const outbox: Scenario = {
  name: "outbox",
  description:
    "Outbox intents: send-to-delivery latency, relay drain throughput of a due backlog, and delivery latency beside 10k, 100k, and (full profile) 10^6 sleeping timers.",
  multiRunner: true,
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const results: Array<CaseResult> = []
      let next = 0

      // Sends one intent and waits until the relay has delivered it to its sink.
      const send = (sender: Effect.Success<ReturnType<typeof Sender.get>>) =>
        Effect.gen(function* () {
          const id = `intent-${next++}`
          const delivered = yield* expect(id)
          yield* sender.Send(id)
          yield* delivered
        })

      for (const workers of [1, 16])
        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              const senders = yield* Effect.forEach(Array.from({ length: workers }), (_, index) =>
                Sender.get(`latency-${index}`),
              )

              yield* Effect.forEach(senders, (sender) => send(sender).pipe(Effect.orDie), {
                concurrency: workers,
              })

              return yield* measure({
                name: workers === 1 ? "delivery-sequential" : `delivery-concurrent-${workers}`,
                parameters: { senders: workers, sinks: 64, workers },
                instruments,
                workers,
                ...(workers === 1
                  ? { operations: quick ? 100 : 1000 }
                  : { durationMs: quick ? 2000 : 10_000 }),
                operation: (index) => send(senders[index % workers]!),
                listStatements: workers === 1,
              })
            }),
          ),
        )

      const backlog = quick ? 2000 : 20_000

      results.push(
        yield* context.withRuntime({}, (instruments) =>
          Effect.gen(function* () {
            const batch = 100
            const ids = Array.from({ length: backlog }, () => `intent-${next++}`)
            const waits = yield* Effect.forEach(ids, expect)
            const sender = yield* Sender.get("backlog")
            const started = yield* databaseNow
            // Far enough ahead that every row is staged before any falls due, even
            // on a shared CI runner where the first turn waits for shard assignment.
            const dueAt = started + (quick ? 15_000 : 30_000)

            yield* Effect.forEach(
              Array.from({ length: backlog / batch }, (_, index) =>
                ids.slice(index * batch, (index + 1) * batch),
              ),
              (chunk) => sender.SendAt({ ids: chunk, atMs: dueAt }).pipe(Effect.orDie),
              { concurrency: 1, discard: true },
            )

            const staged = (yield* databaseNow) - started

            if (staged >= dueAt - started)
              return yield* Effect.die(
                new Error(`Backlog was still staging when it fell due (${staged} ms)`),
              )

            yield* Effect.sleep(dueAt - (yield* databaseNow))

            // Each operation waits for one delivery; the window runs from the due time
            // until the last row is delivered, so throughput is deliveries per second.
            return yield* measure({
              name: `drain-${backlog}`,
              parameters: { intents: backlog, sinks: 64, stagedPerTurn: batch, workers: 64 },
              instruments,
              workers: 64,
              operations: backlog,
              operation: (index) => waits[index]!,
              listStatements: true,
              extra: { stageMs: staged },
            })
          }),
        ),
      )

      // The quick counts are the ones the statement gate checks.
      for (const sleepers of quick ? [10_000, 100_000] : [10_000, 100_000, 1_000_000])
        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              yield* seedSleepers(sleepers, (yield* databaseNow) + 86_400_000)
              const sender = yield* Sender.get("beside-sleepers")
              yield* send(sender).pipe(Effect.orDie)

              const result = yield* measure({
                name: `delivery-beside-${sleepers}-timers`,
                parameters: { sleepingTimers: sleepers, workers: 1 },
                instruments,
                workers: 1,
                operations: quick ? 100 : 1000,
                operation: () => send(sender),
                listStatements: true,
              })

              const scan = scanMeanMs(result)

              return scan === undefined ? result : { ...result, extra: { scanMeanMs: scan } }
            }),
          ),
        )

      return results
    }),
}
