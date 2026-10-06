import { COMMANDS_METER, STORAGE_METER, StripeBilling } from "@akter/billing"
import { Actor } from "@rikalabs/akter"
import {
  bigint,
  boolean,
  doublePrecision,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core"
import {
  Array as Arr,
  Clock,
  DateTime,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Schema,
} from "effect"
import { MeteringRepository, MeteringRepositoryLive } from "./metering-repository.ts"

const HOUR_MS = 3_600_000

const MAX_PROVIDER_EVENTS = 100

const MAX_IMPORT_EVENTS = 500

const KeyText = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]))

const IdentityText = Schema.fromJsonString(Schema.Array(Schema.String))

/** The actor key of one deployment's tenant: the compact JSON array `[deployment, tenant]`. */
export const usageKey = Effect.fnUntraced(function* (deployment: string, tenant: string) {
  return yield* Schema.encodeEffect(KeyText)([deployment, tenant]).pipe(Effect.orDie)
})

/** A deployment tenant's key, as `usageKey` builds it. */
export const UsageKey = Schema.String.check(Schema.isPattern(/^\[".*",".*"\]$/su))

const EventId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/u))

/** The start of a UTC hour, in epoch milliseconds. */
export const HourStart = Schema.Int.check(Schema.isMultipleOf(HOUR_MS))

/**
 * One committed command or completed read a cell recorded. A command's
 * reservation at the edge is named by its `commandId`, a read's by its
 * `requestToken`; an event without the one its kind needs has no reservation to
 * settle. `actorId` is the decoded actor id, empty for a singleton.
 */
export const RequestEvent = Schema.Struct({
  kind: Schema.Literals(["command", "read"]),
  eventId: EventId,
  actorType: Schema.String,
  actorId: Schema.String,
  commandId: Schema.NullOr(Schema.String),
  requestToken: Schema.NullOr(Schema.String),
  hour: HourStart,
})

/** One hourly storage sample of the tenant: the bytes held, summed over the hour, as byte-hours. */
export const StorageEvent = Schema.Struct({
  kind: Schema.Literal("storage"),
  eventId: EventId,
  hour: HourStart,
  storageByteHours: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})

/** A source event as the collector imports it. */
export const MeterEvent = Schema.Union([RequestEvent, StorageEvent])

const EventText = Schema.fromJsonString(MeterEvent)

const MeterName = Schema.Literals([COMMANDS_METER, STORAGE_METER])

const ExportStatus = Schema.Literals(["pending", "accepted", "needs_reconciliation"])

const meterValue = (meter: typeof MeterName.Type, value: number) => ({ meter, value })

const hourDate = (ms: number) => DateTime.toDateUtc(DateTime.makeUnsafe(ms))

const hoursInMonth = (ms: number) => {
  const start = DateTime.startOf(DateTime.makeUnsafe(ms), "month", { weekStartsOn: 1 })
  const end = DateTime.add(start, { months: 1 })

  return (DateTime.toEpochMillis(end) - DateTime.toEpochMillis(start)) / HOUR_MS
}

/**
 * The evidence of every source event the actor took, by the source's event
 * id, kept forever. The organization and project are bound by the insert
 * trigger from the tenant's allocation at import and never change after.
 * `fingerprint` is the event's canonical text, so one event id with another
 * payload is a conflict. A `late` event arrived for an hour already sealed and
 * is not counted.
 */
export const meterEvidence = Actor.table(
  pgTable("cloud_meter_evidence", {
    eventId: text("event_id").primaryKey(),
    kind: text("kind", { enum: ["command", "read", "storage"] }).notNull(),
    deploymentId: text("deployment_id").notNull(),
    tenantName: text("tenant_name").notNull(),
    sourceActorType: text("source_actor_type"),
    sourceActorId: text("source_actor_id"),
    commandId: text("command_id"),
    requestToken: text("request_token"),
    reservationIdentity: text("reservation_identity"),
    hour: timestamp("hour", { withTimezone: true, mode: "date" }).notNull(),
    storageByteHours: doublePrecision("storage_byte_hours"),
    fingerprint: text("fingerprint").notNull(),
    late: boolean("late").notNull().default(false),
    organizationId: text("organization_id").notNull().default(""),
    projectId: text("project_id").notNull().default(""),
  }),
)

/** Counters per hour, organization and project, added by the evidence trigger. */
export const meterHour = Actor.table(
  pgTable(
    "cloud_meter_hour",
    {
      hour: timestamp("hour", { withTimezone: true, mode: "date" }).notNull(),
      organizationId: text("organization_id").notNull(),
      projectId: text("project_id").notNull(),
      commandCount: bigint("command_count", { mode: "number" }).notNull().default(0),
      readCount: bigint("read_count", { mode: "number" }).notNull().default(0),
      storageByteHours: doublePrecision("storage_byte_hours").notNull().default(0),
    },
    (table) => [primaryKey({ columns: [table.hour, table.organizationId, table.projectId] })],
  ),
)

/** The hours the source has been proven complete for; a row makes the hour immutable. */
export const meterSeal = Actor.table(
  pgTable("cloud_meter_seal", {
    hour: timestamp("hour", { withTimezone: true, mode: "date" }).primaryKey(),
    deploymentId: text("deployment_id").notNull(),
    tenantName: text("tenant_name").notNull(),
    sealedThrough: bigint("sealed_through", { mode: "number" }).notNull(),
  }),
)

/**
 * What a sealed hour reports to the provider, per organization and meter: the
 * customer, the deterministic usage key, the gross value, and where delivery
 * stands. `firstAttemptMs` starts the provider's resend window.
 */
export const meterExport = Actor.table(
  pgTable(
    "cloud_meter_export",
    {
      hour: timestamp("hour", { withTimezone: true, mode: "date" }).notNull(),
      organizationId: text("organization_id").notNull(),
      meter: text("meter").notNull(),
      deploymentId: text("deployment_id").notNull(),
      tenantName: text("tenant_name").notNull(),
      customerId: text("customer_id").notNull(),
      usageKey: text("usage_key").notNull(),
      value: doublePrecision("value").notNull(),
      firstAttemptMs: bigint("first_attempt_ms", { mode: "number" }).notNull(),
      status: text("status", { enum: ["pending", "accepted", "needs_reconciliation"] })
        .notNull()
        .default("pending"),
    },
    (table) => [primaryKey({ columns: [table.hour, table.organizationId, table.meter] })],
  ),
)

/** The tenant's allocation to an organization and project does not exist. */
export class TenantUnbound extends Schema.TaggedError<TenantUnbound>()("TenantUnbound", {
  deployment: Schema.String,
  tenant: Schema.String,
}) {}

/** The event id was already imported with a different payload. */
export class EventConflict extends Schema.TaggedError<EventConflict>()("EventConflict", {
  eventId: Schema.String,
}) {}

/** The source is not complete through the end of the hour. */
export class HourOpen extends Schema.TaggedError<HourOpen>()("HourOpen", {
  hour: Schema.Int,
  completeThrough: Schema.Int,
}) {}

/** An organization with usage in the hour has no provider customer yet. */
export class CustomerUnbound extends Schema.TaggedError<CustomerUnbound>()("CustomerUnbound", {
  organizationId: Schema.String,
}) {}

/** What an import did: new events counted, repeats ignored, and events for sealed hours set aside. */
export const ImportResult = Schema.Struct({
  imported: Schema.Int,
  duplicates: Schema.Int,
  late: Schema.Array(Schema.String),
})

/** Where a sealed or open hour stands. */
export const HourReport = Schema.Struct({
  sealed: Schema.Boolean,
  exports: Schema.Array(
    Schema.Struct({
      organizationId: Schema.String,
      meter: Schema.String,
      value: Schema.Finite,
      status: ExportStatus,
    }),
  ),
})

/**
 * Takes source events for the tenant. An event is recorded once by its id:
 * a repeat with the same payload is a duplicate and one with another payload
 * fails `EventConflict`, undoing the whole batch. Events for a sealed hour are
 * kept as late evidence and not counted.
 */
export const Import = Actor.command("Import", {
  payload: {
    events: Schema.Array(MeterEvent).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_IMPORT_EVENTS),
    ),
  },
  success: ImportResult,
  error: Schema.Union([TenantUnbound, EventConflict]),
})

/**
 * Makes the hour immutable and queues its usage for the provider. The caller
 * proves the source complete through `completeThrough` (epoch milliseconds);
 * the hour must end at or before it.
 */
export const Seal = Actor.command("Seal", {
  payload: { hour: HourStart, completeThrough: Schema.Int },
  success: Schema.Struct({
    status: Schema.Literals(["sealed", "already_sealed"]),
    queued: Schema.Int,
  }),
  error: Schema.Union([HourOpen, CustomerUnbound]),
})

/** An hour's seal and delivery state. */
export const GetHour = Actor.query("GetHour", {
  payload: { hour: HourStart },
  success: HourReport,
})

const ExportRef = Schema.Struct({
  organizationId: Schema.String,
  meter: MeterName,
  hour: HourStart,
})

/** Reports hourly usage to the provider under deterministic identifiers; a repeat after a lost answer sends the same ones. */
export const Flush = Actor.job("Flush", {
  payload: {
    firstAttemptMs: Schema.Int,
    events: Schema.Array(
      Schema.Struct({
        organizationId: Schema.String,
        meter: MeterName,
        customerId: Schema.String,
        key: Schema.String,
        value: Schema.Finite,
        hour: HourStart,
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PROVIDER_EVENTS)),
  },
  success: Schema.Union([
    Schema.TaggedStruct("Accepted", { exports: Schema.Array(ExportRef) }),
    Schema.TaggedStruct("Quarantined", { exports: Schema.Array(ExportRef), reason: Schema.String }),
  ]),
})

const FlushResolved = Actor.command("FlushResolved", { payload: Flush.success })

const FlushDeadLettered = Actor.command("FlushDeadLettered", {
  payload: Actor.DeadLetter(Flush),
})

/**
 * The metering authority of one deployment tenant, keyed by `usageKey`. Only
 * `System` callers reach it: the collector and the job routes. Its turns
 * write meter tables whose triggers roll usage up into shared control tables,
 * so it is authority-placed: its rows commit with those tables on one shard.
 */
export const UsageActor = Actor.make("UsageActor", {
  key: UsageKey,
  placement: "authority",
  tables: [meterEvidence, meterHour, meterSeal, meterExport],
  api: { Import, Seal, GetHour },
  internal: { FlushResolved, FlushDeadLettered },
  jobs: {
    Flush: {
      job: Flush,
      onSuccess: FlushResolved,
      onDeadLetter: FlushDeadLettered,
      retry: { times: 10, backoff: { base: "1 minute", max: "2 hours" } },
    },
  },
  access: ({ caller }) => Predicate.isTagged(caller, "System"),
})

export interface UsageActorOptions {
  /** Milliseconds since the epoch; defaults to the Effect clock. Tests pass their own. */
  readonly clock?: Effect.Effect<number>
  /**
   * How long after an export's first provider attempt the same identifiers may
   * still be sent. Default 23 hours, inside the provider's 24 hour
   * deduplication window; past it nothing is resent and the export needs
   * reconciliation.
   */
  readonly resendWindow?: Duration.Input
}

const settings = (options: UsageActorOptions) => ({
  clock: options.clock ?? Clock.currentTimeMillis,
  windowMs: Duration.toMillis(Duration.fromInputUnsafe(options.resendWindow ?? "23 hours")),
})

/** Command handlers of `UsageActor`; nothing here calls the provider. */
export const UsageActorCommands = (options: UsageActorOptions = {}) =>
  UsageActor.toLayer(
    Effect.gen(function* () {
      const repository = yield* MeteringRepository
      const { clock, windowMs } = settings(options)

      const tenantOf = (id: string) => Schema.decodeEffect(KeyText)(id).pipe(Effect.orDie)

      const settleExports = Effect.fnUntraced(function* (
        refs: ReadonlyArray<typeof ExportRef.Type>,
        status: "accepted" | "needs_reconciliation",
      ) {
        const turn = yield* UsageActor.Turn
        const exports = turn.rows(meterExport)

        for (const { organizationId, meter, hour } of refs) {
          const where = { hour: { eq: hourDate(hour) }, organizationId, meter }
          const current = yield* exports.one({ where })

          if (Option.isSome(current) && current.value.status === "pending")
            yield* exports.update({ status }).where(where)
        }
      })

      return {
        Import: Effect.fnUntraced(function* ({ events }) {
          const turn = yield* UsageActor.Turn
          const [deployment, tenant] = yield* tenantOf(turn.id)

          if (Option.isNone(yield* repository.binding(deployment, tenant)))
            return yield* TenantUnbound.make({ deployment, tenant })

          const evidence = turn.rows(meterEvidence)

          const existing = new Map(
            (yield* evidence.all({
              where: { eventId: { in: events.map(({ eventId }) => eventId) } },
            })).map((row) => [row.eventId, row.fingerprint]),
          )

          const sealed = new Set(
            (yield* turn.rows(meterSeal).all({
              where: { hour: { in: Arr.dedupe(events.map(({ hour }) => hourDate(hour))) } },
            })).map((row) => row.hour.getTime()),
          )

          const fresh = new Map<
            string,
            Omit<typeof meterEvidence.$inferInsert, "routing_key" | "tenant_id" | "actor_id">
          >()
          let duplicates = 0

          for (const event of events) {
            const fingerprint = yield* Schema.encodeEffect(EventText)(event).pipe(Effect.orDie)
            const known = existing.get(event.eventId) ?? fresh.get(event.eventId)?.fingerprint

            if (known === undefined) {
              const request = event.kind === "storage" ? undefined : event
              const reservationKey =
                request === undefined
                  ? undefined
                  : request.kind === "command"
                    ? request.commandId
                    : request.requestToken

              fresh.set(event.eventId, {
                eventId: event.eventId,
                kind: event.kind,
                deploymentId: deployment,
                tenantName: tenant,
                sourceActorType: request?.actorType ?? null,
                sourceActorId: request?.actorId ?? null,
                commandId: request?.commandId ?? null,
                requestToken: request?.requestToken ?? null,
                reservationIdentity:
                  request === undefined || reservationKey === null || reservationKey === undefined
                    ? null
                    : yield* Schema.encodeEffect(IdentityText)([
                        deployment,
                        tenant,
                        request.actorType,
                        request.actorId,
                        reservationKey,
                      ]).pipe(Effect.orDie),
                hour: hourDate(event.hour),
                storageByteHours: event.kind === "storage" ? event.storageByteHours : null,
                fingerprint,
                late: sealed.has(event.hour),
              })
              continue
            }

            if (known !== fingerprint) return yield* EventConflict.make({ eventId: event.eventId })

            duplicates += 1
          }

          const rows = [...fresh.values()]

          if (rows.length > 0) yield* evidence.insert(rows)

          return {
            imported: rows.filter((row) => row.late !== true).length,
            duplicates,
            late: rows.flatMap((row) => (row.late === true ? [row.eventId] : [])),
          }
        }),
        Seal: Effect.fnUntraced(function* ({ hour, completeThrough }) {
          const turn = yield* UsageActor.Turn

          if (hour + HOUR_MS > completeThrough)
            return yield* HourOpen.make({ hour, completeThrough })

          const date = hourDate(hour)
          const seals = turn.rows(meterSeal)

          if (Option.isSome(yield* seals.one({ where: { hour: { eq: date } } })))
            return { status: "already_sealed" as const, queued: 0 }

          const [deployment, tenant] = yield* tenantOf(turn.id)
          const counters = yield* turn.rows(meterHour).all({ where: { hour: { eq: date } } })

          const byOrganization = new Map<string, { units: number; byteHours: number }>()

          for (const row of counters) {
            const total = byOrganization.get(row.organizationId) ?? { units: 0, byteHours: 0 }

            byOrganization.set(row.organizationId, {
              units: total.units + row.commandCount * 5 + row.readCount,
              byteHours: total.byteHours + row.storageByteHours,
            })
          }

          const firstAttemptMs = yield* clock
          const key = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.Int])),
          )([deployment, tenant, hour]).pipe(Effect.orDie)
          const events: Array<(typeof Flush.Type)["events"][number]> = []

          for (const [organizationId, total] of byOrganization) {
            const values = [
              meterValue(COMMANDS_METER, total.units / 5),
              meterValue(STORAGE_METER, total.byteHours / 1_000_000_000 / hoursInMonth(hour)),
            ].filter(({ value }) => value > 0)

            if (values.length === 0) continue

            const customer = yield* repository.customerOf(organizationId)

            if (Option.isNone(customer)) return yield* CustomerUnbound.make({ organizationId })

            for (const { meter, value } of values)
              events.push({ organizationId, meter, customerId: customer.value, key, value, hour })
          }

          if (events.length > 0)
            yield* turn.rows(meterExport).insert(
              events.map((event) => ({
                hour: date,
                organizationId: event.organizationId,
                meter: event.meter,
                deploymentId: deployment,
                tenantName: tenant,
                customerId: event.customerId,
                usageKey: event.key,
                value: event.value,
                firstAttemptMs,
              })),
            )

          yield* seals.insert({
            hour: date,
            deploymentId: deployment,
            tenantName: tenant,
            sealedThrough: completeThrough,
          })

          const chunks = Arr.chunksOf(events, MAX_PROVIDER_EVENTS)

          for (const chunk of chunks)
            yield* turn.enqueue(Flush.make({ firstAttemptMs, events: chunk }))

          return { status: "sealed" as const, queued: chunks.length }
        }),
        FlushResolved: (result) =>
          Match.value(result).pipe(
            Match.tag("Accepted", ({ exports }) => settleExports(exports, "accepted")),
            Match.tag("Quarantined", ({ exports }) =>
              settleExports(exports, "needs_reconciliation"),
            ),
            Match.exhaustive,
          ),
        FlushDeadLettered: Effect.fnUntraced(function* ({ job }) {
          const turn = yield* UsageActor.Turn
          const now = yield* clock

          if (now - job.firstAttemptMs <= windowMs) {
            yield* turn.enqueue(
              Flush.make({ firstAttemptMs: job.firstAttemptMs, events: job.events }),
            )
            return
          }

          yield* settleExports(
            job.events.map(({ organizationId, meter, hour }) => ({ organizationId, meter, hour })),
            "needs_reconciliation",
          )
        }),
      }
    }),
  )

/** Query handlers of `UsageActor`, reading committed rows. */
export const UsageActorReads = UsageActor.toQueryLayer({
  GetHour: Effect.fnUntraced(function* ({ hour }) {
    const read = yield* UsageActor.Read
    const where = { hour: { eq: hourDate(hour) } }
    const seal = yield* read.rows(meterSeal).one({ where })
    const exports = yield* read.rows(meterExport).all({ where, orderBy: { meter: "asc" } })

    return {
      sealed: Option.isSome(seal),
      exports: exports.map(({ organizationId, meter, value, status }) => ({
        organizationId,
        meter,
        value,
        status,
      })),
    }
  }),
})

/**
 * The provider calls of `UsageActor`, run after the turn that enqueued them
 * commits. The same events (same identifiers) are sent on every attempt, so a
 * lost answer is repeated safely until the resend window closes; after that, or
 * for a rejection no retry can fix, the result is a `Quarantined` outcome
 * instead of an error, and the export waits for reconciliation.
 */
export const UsageActorJobs = (options: UsageActorOptions = {}) =>
  UsageActor.toJobLayer(
    Effect.gen(function* () {
      const billing = yield* StripeBilling
      const { clock, windowMs } = settings(options)

      const flush = ({ firstAttemptMs, events }: typeof Flush.Type) => {
        const exports = events.map(({ organizationId, meter, hour }) => ({
          organizationId,
          meter,
          hour,
        }))
        const quarantined = (reason: string) =>
          Effect.succeed({ _tag: "Quarantined" as const, exports, reason })

        return Effect.gen(function* () {
          if ((yield* clock) - firstAttemptMs > windowMs)
            return yield* quarantined("resend_window_elapsed")

          yield* billing.recordUsage(
            events.map(({ meter, customerId, key, value, hour }) => ({
              meter,
              customerId,
              key,
              value,
              occurredAt: DateTime.makeUnsafe(hour),
            })),
          )

          return { _tag: "Accepted" as const, exports }
        }).pipe(
          Effect.catchTags({
            UnknownMeter: () => quarantined("unknown_meter"),
            BillingProviderError: (error) =>
              error.retryable ? Effect.fail(error) : quarantined("provider_rejected"),
          }),
        )
      }

      return { Flush: flush }
    }),
  )

/**
 * The `UsageActor` with its commands, queries and executors over the metering
 * schema. Requires `StripeBilling` and an actor runtime; provides
 * `MeteringRepository`.
 */
export const UsageActorLive = (options: UsageActorOptions = {}) =>
  Layer.mergeAll(UsageActorCommands(options), UsageActorReads, UsageActorJobs(options)).pipe(
    Layer.provideMerge(MeteringRepositoryLive),
  )
