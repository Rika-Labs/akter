import {
  defaultPricingConfig,
  PricingLive,
  StripeBilling,
  StripeBillingLocal,
  stripeTiers,
} from "@akter/billing"
import { BunCrypto } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import { ActorTest, TurnHooks } from "@rikalabs/akter/testing"
import { Context, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import { BillingActor, BillingActorLive } from "./billing-actor.ts"
import {
  CollectorActor,
  CollectorCommands,
  CollectorJobs,
  MeterSources,
  MeterSourcesLive,
} from "./collector.ts"
import { createDatabase } from "./fixtures.ts"
import { UsageActor, UsageActorLive, usageKey } from "./metering-actor.ts"

const deployment = "collector-test-cell"
const current = DateTime.startOf(DateTime.nowUnsafe(), "hour")
const hour = DateTime.formatIso(DateTime.subtract(current, { hours: 2 }))
const nextHour = DateTime.formatIso(DateTime.subtract(current, { hours: 1 }))
const hourMs = DateTime.toEpochMillis(DateTime.makeUnsafe(hour))
const nextHourMs = DateTime.toEpochMillis(DateTime.makeUnsafe(nextHour))
const firstLabel = hour.slice(0, 19)
const nextLabel = nextHour.slice(0, 19)

const monthDurationHours = (iso: string) => {
  const start = DateTime.startOf(DateTime.makeUnsafe(iso), "month")
  return (
    (DateTime.toEpochMillis(DateTime.add(start, { months: 1 })) - DateTime.toEpochMillis(start)) /
    3_600_000
  )
}

const firstMonthHours = monthDurationHours(hour)
const nextMonthHours = monthDurationHours(nextHour)

/** A fixture connection to the cell database, separate from the executor-facing provider capability. */
class SourceDatabase extends Context.Service<SourceDatabase, SqlClient.SqlClient>()(
  "@akter/api/collector.test/SourceDatabase",
) {}

const live = (controlUrl: Redacted.Redacted<string>, sourceUrl: Redacted.Redacted<string>) =>
  Layer.mergeAll(
    BillingActorLive(),
    UsageActorLive(),
    Layer.effect(SourceDatabase, SqlClient.SqlClient).pipe(
      Layer.provide(PgClient.layer({ url: sourceUrl, maxConnections: 2 })),
    ),
    Layer.merge(CollectorCommands, CollectorJobs).pipe(
      Layer.provideMerge(MeterSourcesLive([{ deploymentId: deployment, databaseUrl: sourceUrl }])),
    ),
  ).pipe(
    Layer.provideMerge(
      StripeBillingLocal({
        tiers: stripeTiers(defaultPricingConfig),
        webhookSecret: Redacted.make("collector-local-test-secret"),
      }),
    ),
    Layer.provide(PricingLive()),
    Layer.provideMerge(ActorTest.layer({ database: controlUrl })),
    Layer.provideMerge(BunCrypto.layer),
  )

type Services = Layer.Success<ReturnType<typeof live>>

/** Each scenario has a cell database and a control-plane database of its own, and uses the real local provider. */
const run = <A, E>(
  body: Effect.Effect<A, E, Services>,
  hook: Effect.Success<typeof TurnHooks> = { at: () => Effect.void },
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const cryptoContext = yield* Layer.build(BunCrypto.layer)
        const controlUrl = yield* createDatabase("collector_control").pipe(
          Effect.provideContext(cryptoContext),
        )
        const sourceUrl = yield* createDatabase("collector_source").pipe(
          Effect.provideContext(cryptoContext),
        )
        const context = yield* Layer.build(live(controlUrl, sourceUrl)).pipe(
          Effect.provideService(TurnHooks, hook),
        )

        return yield* body.pipe(Effect.provideContext(context))
      }),
    ),
  )

const allocated = Effect.fnUntraced(function* (
  tenant: string,
  organizationId: string,
  projectId: string,
) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO cloud_meter_tenant (deployment_id, tenant, organization_id, project_id)
    VALUES (${deployment}, ${tenant}, ${organizationId}, ${projectId})`
  const billing = yield* BillingActor.get(organizationId)
  yield* billing.InitializeAccount({ email: `${organizationId}@example.test` })
  yield* (yield* ActorTest).advance(0)
  expect((yield* billing.GetAccount())?.customerId).not.toBe(null)
})

/** These are historical journal fixtures, not evidence that storage was sampled in the past. */
const seedHour = Effect.fnUntraced(function* (
  tenant: string,
  start: string,
  offset: number,
  commands: number,
  reads: number,
  storageByteHours: number,
) {
  const sql = yield* SourceDatabase
  const count = commands + reads + 1
  yield* sql`
    INSERT INTO cloud_meter_cell_journal
      (event_id, deployment_id, tenant_id, actor_type, actor_id, command_id, request_token,
       kind, hour, recorded_at, storage_byte_hours)
    SELECT ('00000000-0000-4000-8000-' || lpad((n + ${offset})::text, 12, '0'))::uuid,
      ${deployment}, ${tenant}, 'Counter', 'fixture',
      CASE WHEN n <= ${commands} THEN 'fixture-command-' || (${offset} + n)::text ELSE NULL END,
      CASE WHEN n > ${commands} AND n <= ${commands + reads}
        THEN 'fixture-read-' || (${offset} + n)::text ELSE NULL END,
      CASE WHEN n <= ${commands} THEN 'command'
        WHEN n <= ${commands + reads} THEN 'read' ELSE 'storage' END,
      ${start}::timestamptz, ${start}::timestamptz,
      CASE WHEN n = ${count} THEN ${storageByteHours}::bigint ELSE NULL END
    FROM generate_series(1, ${count}) n
  `
})

const sourceCounts = Effect.gen(function* () {
  const sql = yield* SourceDatabase
  return yield* sql<{
    readonly hour: string
    readonly total: number
    readonly acknowledged: number
  }>`SELECT to_char(hour AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS hour,
      count(*)::int AS total, count(acked_at)::int AS acknowledged
    FROM cloud_meter_cell_journal GROUP BY hour ORDER BY hour`
})

const rollups = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* sql<{
    readonly tenant: string
    readonly organization_id: string
    readonly project_id: string
    readonly hour: string
    readonly commands: number
    readonly reads: number
    readonly byte_hours: number
    readonly sealed: boolean
    readonly sent: boolean
  }>`SELECT tenant, organization_id, project_id,
      to_char(hour AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS hour,
      command_count::int AS commands, read_count::int AS reads,
      storage_byte_hours AS byte_hours, sealed, sent
    FROM cloud_usage_hour ORDER BY hour, tenant`
})

const advanceRetries = Effect.gen(function* () {
  const test = yield* ActorTest
  for (let attempt = 0; attempt < 5; attempt += 1) yield* test.advance("1 minute")
})

describe("CollectorActor with the real cell journal and local Stripe provider", () => {
  it("finishes a paginated hour after all source acknowledgements commit but collector progress is lost", () => {
    let importExecutions = 0
    let crashed = false
    const JobCursor = Schema.fromJsonString(Schema.Struct({ phase: Schema.String }))

    return run(
      Effect.gen(function* () {
        const source = yield* (yield* MeterSources).get(deployment)
        const emptyStorage = yield* source.journal.sampleStorage(yield* source.currentHour)
        expect(emptyStorage.samples).toEqual([])
        expect(yield* source.journal.ack([])).toBe(0)
        yield* allocated("alpha", "org-alpha", "project-alpha")
        yield* allocated("beta", "org-beta", "project-beta")
        yield* (yield* StripeBilling).ensureCatalog
        yield* seedHour("alpha", hour, 0, 267, 33, 12_000_000_000)
        yield* seedHour("beta", hour, 1000, 17, 11, 3_000_000_000)
        yield* seedHour("alpha", nextHour, 2000, 2, 5, 7_000_000_000)

        const collector = yield* CollectorActor.get(deployment)
        const test = yield* ActorTest
        yield* collector.Start()
        yield* test.advance(0)

        expect(crashed).toBe(true)
        expect(importExecutions).toBe(2)
        expect(yield* sourceCounts).toEqual([
          { hour: firstLabel, total: 330, acknowledged: 330 },
          { hour: nextLabel, total: 8, acknowledged: 0 },
        ])
        expect((yield* test.inspect(collector.ref)).state).toMatchObject({
          hour: hourMs,
          phase: "import",
          busy: true,
        })
        const first = yield* UsageActor.get(yield* usageKey(deployment, "alpha"))
        expect((yield* first.GetHour({ hour: hourMs })).sealed).toBe(false)

        yield* test.advance("1 minute")

        expect(yield* sourceCounts).toEqual([
          { hour: firstLabel, total: 330, acknowledged: 330 },
          { hour: nextLabel, total: 8, acknowledged: 8 },
        ])
        expect(yield* rollups).toEqual([
          {
            tenant: "alpha",
            organization_id: "org-alpha",
            project_id: "project-alpha",
            hour: firstLabel,
            commands: 267,
            reads: 33,
            byte_hours: 12_000_000_000,
            sealed: true,
            sent: true,
          },
          {
            tenant: "beta",
            organization_id: "org-beta",
            project_id: "project-beta",
            hour: firstLabel,
            commands: 17,
            reads: 11,
            byte_hours: 3_000_000_000,
            sealed: true,
            sent: true,
          },
          {
            tenant: "alpha",
            organization_id: "org-alpha",
            project_id: "project-alpha",
            hour: nextLabel,
            commands: 2,
            reads: 5,
            byte_hours: 7_000_000_000,
            sealed: true,
            sent: true,
          },
        ])
        const sql = yield* SqlClient.SqlClient
        expect(
          yield* sql<{ organization_id: string; units: number; storage: number }>`
          SELECT organization_id, sum(command_units)::int AS units, sum(storage_gb_months) AS storage
          FROM cloud_usage_account GROUP BY organization_id ORDER BY organization_id
        `,
        ).toEqual([
          {
            organization_id: "org-alpha",
            units: 269 * 5 + 38,
            storage: 12 / firstMonthHours + 7 / nextMonthHours,
          },
          { organization_id: "org-beta", units: 17 * 5 + 11, storage: 3 / firstMonthHours },
        ])
        const reported = yield* sql<{ meter: string; value: number; hour: string }>`
          SELECT meter, value, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS hour
          FROM cloud_billing_meter_event ORDER BY hour, meter, value`
        expect(reported).toEqual([
          { meter: "commands", value: 19.2, hour: firstLabel },
          { meter: "commands", value: 273.6, hour: firstLabel },
          { meter: "storageGb", value: 3 / firstMonthHours, hour: firstLabel },
          { meter: "storageGb", value: 12 / firstMonthHours, hour: firstLabel },
          { meter: "commands", value: 3, hour: nextLabel },
          { meter: "storageGb", value: 7 / nextMonthHours, hour: nextLabel },
        ])
        const snapshot = yield* rollups
        yield* collector.Start()
        yield* test.advance("1 minute")
        expect(yield* rollups).toEqual(snapshot)
        expect(yield* sql`SELECT identifier FROM cloud_billing_meter_event`).toHaveLength(6)
        expect((yield* first.GetHour({ hour: nextHourMs })).sealed).toBe(true)
      }),
      {
        at: (point, request) => {
          if (point !== "afterExecute" || request.ref.actor !== "CollectorActor" || crashed)
            return Effect.void
          const cursor = Schema.decodeOption(JobCursor)(request.payload)
          if (Option.isNone(cursor) || cursor.value.phase !== "import") return Effect.void
          importExecutions += 1
          if (importExecutions !== 2) return Effect.void
          crashed = true
          return Effect.die(new Error("Lost Collect result after source acknowledgement"))
        },
      },
    )
  })

  it("does not acknowledge a partially imported page when one tenant is unbound, and retries it without charging the imported tenant twice", () =>
    run(
      Effect.gen(function* () {
        yield* allocated("known", "org-known", "project-known")
        yield* seedHour("known", hour, 0, 3, 5, 12_000_000_000)
        yield* seedHour("unbound", hour, 1000, 17, 33, 7_000_000_000)
        const collector = yield* CollectorActor.get(deployment)
        const test = yield* ActorTest
        yield* collector.Start()
        yield* test.advance(0)
        yield* advanceRetries

        expect(yield* sourceCounts).toEqual([{ hour: firstLabel, total: 60, acknowledged: 0 }])
        const interrupted = yield* test.inspect(collector.ref)
        expect(interrupted.state).toMatchObject({
          hour: hourMs,
          phase: "import",
          busy: true,
        })
        expect(interrupted.jobs).toBe(1)
        expect(yield* test.receiptsFor(collector.ref, "Failed")).toBeGreaterThanOrEqual(1)
        expect(yield* test.receiptsFor(collector.ref, "Poll")).toBeGreaterThanOrEqual(1)
        const sql = yield* SqlClient.SqlClient
        const pending = yield* sql<{ intent_id: string; attempts: number }>`
          SELECT intent_id, attempts FROM actor_outbox
          WHERE actor_type = 'CollectorActor' AND actor_id = ${deployment} AND kind = 'job'`
        const dead = yield* sql<{ job_id: string }>`
          SELECT job_id FROM actor_dead_letters
          WHERE actor_type = 'CollectorActor' AND actor_id = ${deployment}`
        expect(pending).toHaveLength(1)
        expect(pending[0]?.attempts).toBeGreaterThanOrEqual(1)
        expect(dead).toHaveLength(1)
        expect(pending[0]?.intent_id).not.toBe(dead[0]?.job_id)
        expect(
          (yield* rollups).map(({ tenant, commands, reads }) => ({ tenant, commands, reads })),
        ).toEqual([{ tenant: "known", commands: 3, reads: 5 }])

        yield* allocated("unbound", "org-recovered", "project-recovered")
        yield* advanceRetries
        expect(yield* sourceCounts).toEqual([{ hour: firstLabel, total: 60, acknowledged: 60 }])
        expect(
          (yield* rollups).map(({ tenant, commands, reads, sealed, sent }) => ({
            tenant,
            commands,
            reads,
            sealed,
            sent,
          })),
        ).toEqual([
          { tenant: "known", commands: 3, reads: 5, sealed: true, sent: true },
          { tenant: "unbound", commands: 17, reads: 33, sealed: true, sent: true },
        ])
        expect(
          yield* sql<{ organization_id: string; units: number }>`
          SELECT organization_id, command_units::int AS units FROM cloud_usage_account ORDER BY organization_id
        `,
        ).toEqual([
          { organization_id: "org-known", units: 20 },
          { organization_id: "org-recovered", units: 118 },
        ])
      }),
    ))
})
