import { Effect, Schedule } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { summarize } from "../measure.ts"
import { CronProbe } from "../probe/contract.ts"
import { cronFires } from "../probe/layer.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

const MINUTE = 60_000

const WORKERS = 64

const databaseNow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const [row] = yield* sql<{
    readonly now: string
  }>`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now`

  return Number(row!.now)
}).pipe(Effect.orDie)

/** Each actor's first tick since `from`, as lateness after `scheduled`. */
const firstFires = (from: number, scheduled: number) => {
  const first = new Map<string, number>()

  for (const fire of cronFires.slice(from))
    if (!first.has(fire.id)) first.set(fire.id, fire.at - scheduled)

  return first
}

/**
 * Waits until every actor's tick has fired since `from`, or dies after the
 * timeout. A drain longer than a minute also runs early actors' next ticks,
 * so it counts actors, not handler runs.
 */
const drained = (from: number, scheduled: number, count: number) =>
  Effect.sync(() => firstFires(from, scheduled).size >= count).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("100 millis"),
      until: (done) => done,
    }),
    Effect.timeoutOrElse({
      duration: "5 minutes",
      orElse: () =>
        Effect.die(
          new Error(`Only ${firstFires(from, scheduled).size} of ${count} cron ticks fired`),
        ),
    }),
  )

/**
 * One round on a fresh database: creates every actor (which writes its tick
 * row), moves every tick to one shared minute boundary at least 5 seconds
 * ahead, and waits until each has fired. Lateness is the handler's wall time
 * minus that boundary, on the host that runs the database too.
 */
const round = (actors: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const created = performance.now()

    yield* Effect.forEach(
      Array.from({ length: actors }, (_, index) => index),
      (index) => CronProbe.get(`cron-${index}`).pipe(Effect.flatMap((probe) => probe.Open())),
      { concurrency: WORKERS, discard: true },
    ).pipe(Effect.orDie)

    const createMs = Math.round(performance.now() - created)
    const scheduled = Math.ceil(((yield* databaseNow) + 5000) / MINUTE) * MINUTE

    yield* sql`UPDATE actor_outbox SET due_at_ms = ${scheduled}, scheduled_at_ms = ${scheduled}
      WHERE actor_type = 'CronProbe' AND timer_key LIKE '$cron:%'`.pipe(Effect.orDie)
    yield* sql`ANALYZE actor_outbox`.pipe(Effect.orDie)

    const [pending] = yield* sql<{
      readonly count: string
    }>`SELECT count(*)::text AS count
      FROM actor_outbox WHERE actor_type = 'CronProbe' AND due_at_ms = ${scheduled}`.pipe(
      Effect.orDie,
    )

    return { scheduled, createMs, pending: Number(pending!.count) }
  })

const scanMeanMs = (result: CaseResult) =>
  result.statements?.find((statement) => statement.query.includes("SKIP LOCKED"))?.meanMs ?? -1

/**
 * `policy.cron` at scale: every actor has a minutely entry, and all their
 * ticks fall due at one minute boundary. Reports tick lateness (handler wall
 * time after the scheduled minute), the drain time of the whole boundary, and
 * the relay claim statement's mean time while it drains.
 */
export const cron: Scenario = {
  name: "cron",
  description:
    "Minutely policy.cron ticks on 10k (quick) or 100k actors falling due at one minute boundary: tick lateness p50/p99/max, drain time, and the relay claim statement's mean time.",
  multiRunner: true,
  run: (context) =>
    Effect.gen(function* () {
      // The claim filter and multi-runner uniqueness are Postgres properties;
      // PGlite would only time one connection draining 100k turns.
      if (context.backend.name !== "postgres") return []

      const quick = context.profile === "quick"
      const actors = quick ? 10_000 : 100_000
      const repeats = quick ? 1 : 3
      const lateness: Array<number> = []
      const rounds: Array<CaseResult & { readonly p99: number; readonly createMs: number }> = []

      for (let repeat = 0; repeat < repeats; repeat++)
        rounds.push(
          yield* context.withRuntime(
            { maxResidentActors: actors, maxConnections: 20 },
            (instruments) =>
              Effect.gen(function* () {
                const { scheduled, createMs, pending } = yield* round(actors)

                if (pending !== actors)
                  return yield* Effect.die(
                    new Error(`Expected ${actors} pending ticks, found ${pending}`),
                  )

                const from = cronFires.length
                let waitedMs = 0

                const result = yield* measure({
                  name: `tick-${actors}`,
                  parameters: { actors },
                  instruments,
                  workers: 1,
                  operations: 1,
                  operation: () =>
                    Effect.gen(function* () {
                      // Sampling spans the wait so early claims count; the drain time excludes it.
                      waitedMs = Math.max(0, scheduled - (yield* databaseNow))
                      yield* Effect.sleep(waitedMs)
                      yield* drained(from, scheduled, actors)
                    }),
                  listStatements: true,
                })

                // A short settle catches a tick whose handler ran twice.
                yield* Effect.sleep("1 second")
                const fires = [...firstFires(from, scheduled).values()]
                lateness.push(...fires)
                const runs = cronFires.slice(from)

                return {
                  ...result,
                  elapsedMs: result.elapsedMs - waitedMs,
                  p99: summarize(fires).p99,
                  createMs,
                  extra: {
                    duplicates: runs.length - new Set(runs.map((run) => run.commandId)).size,
                  },
                }
              }),
          ),
        )

      const summary = summarize(lateness)
      const last = rounds.at(-1)!

      return [
        {
          ...last,
          name: `tick-${actors}`,
          parameters: {
            actors,
            schedule: "* * * * *",
            workers: WORKERS,
            repeats,
          },
          operations: lateness.length,
          elapsedMs: rounds.reduce((total, result) => total + result.elapsedMs, 0),
          throughput: Math.round((lateness.length * 1000) / Math.max(1, summary.max)),
          latencyMs: summary,
          extra: {
            latenessP50Ms: summary.p50,
            latenessP99Ms: summary.p99,
            latenessMaxMs: summary.max,
            roundP99sMs: rounds.map((result) => result.p99).join(","),
            relayClaimMeanMs: scanMeanMs(last),
            roundClaimMeanMs: rounds.map(scanMeanMs).join(","),
            createMs: rounds.map((result) => result.createMs).join(","),
            duplicates: rounds.reduce(
              (total, result) => total + Number(result.extra?.["duplicates"] ?? 0),
              0,
            ),
          },
        },
      ]
    }),
}
