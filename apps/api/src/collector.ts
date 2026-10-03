import { CellUsage, CellUsageLive, type JournalEvent } from "@akter/metering"
import { PgClient } from "@effect/sql-pg"
import { Actor } from "@rikalabs/akter"
import { Context, DateTime, Effect, Layer, Predicate, type Redacted, Schema } from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import { MeterEvent, UsageActor, usageKey } from "./metering-actor.ts"

const HOUR_MS = 3_600_000
const TENANTS_PER_JOB = 128

export interface MeterCell {
  readonly deploymentId: string
  readonly databaseUrl: Redacted.Redacted<string>
}

interface Source {
  readonly journal: CellUsage["Service"]
  readonly currentHour: Effect.Effect<DateTime.Utc, SqlError.SqlError>
  readonly tenants: (
    hour: DateTime.Utc,
    after: string | null,
  ) => Effect.Effect<ReadonlyArray<string>, SqlError.SqlError>
}

/** Configured cell access is a provider capability; collector progress is held by actors, not this registry. */
export class MeterSources extends Context.Service<
  MeterSources,
  {
    readonly get: (deploymentId: string) => Effect.Effect<Source>
  }
>()("@akter/api/collector/MeterSources") {}

export const MeterSourcesLive = (cells: ReadonlyArray<MeterCell>) =>
  Layer.effect(
    MeterSources,
    Effect.gen(function* () {
      const sources = new Map<string, Source>()
      for (const cell of cells) {
        if (sources.has(cell.deploymentId))
          return yield* Effect.die(new Error("Duplicate metering deployment configuration"))
        const context = yield* Layer.build(
          CellUsageLive({ deploymentId: cell.deploymentId }).pipe(
            Layer.provideMerge(PgClient.layer({ url: cell.databaseUrl, maxConnections: 3 })),
          ),
        )
        const sql = Context.get(context, SqlClient.SqlClient)
        sources.set(cell.deploymentId, {
          journal: Context.get(context, CellUsage),
          currentHour: sql<{
            readonly hour: Date
          }>`SELECT date_trunc('hour', clock_timestamp(), 'UTC') AS hour`.pipe(
            Effect.flatMap(([row]) =>
              row === undefined
                ? Effect.die(new Error("Cell clock is unavailable"))
                : Effect.succeed(DateTime.fromDateUnsafe(row.hour)),
            ),
          ),
          tenants: (hour, after) =>
            sql<{ readonly tenant: string }>`
          SELECT DISTINCT tenant_id AS tenant FROM cloud_meter_cell_journal
          WHERE deployment_id = ${cell.deploymentId} AND hour = ${DateTime.formatIso(hour)}::timestamptz
            AND (${after}::text IS NULL OR tenant_id > ${after})
          ORDER BY tenant_id LIMIT ${TENANTS_PER_JOB + 1}
        `.pipe(Effect.map((rows) => rows.map((row) => row.tenant))),
        })
      }
      return MeterSources.of({
        get: (deploymentId) => {
          const source = sources.get(deploymentId)
          return source === undefined
            ? Effect.die(new Error("Metering deployment is not configured"))
            : Effect.succeed(source)
        },
      })
    }),
  )

const Phase = Schema.Literals(["discover", "import", "seal"])
const Cursor = Schema.Struct({
  hour: Schema.NullOr(Schema.Int),
  phase: Phase,
  afterTenant: Schema.NullOr(Schema.String),
})

const Start = Actor.command("Start")
const Poll = Actor.command("Poll")
const Progress = Actor.command("Progress", {
  payload: { cursor: Cursor, continueNow: Schema.Boolean },
})
const Collect = Actor.job("Collect", {
  payload: Cursor.fields,
  success: Schema.Struct({ cursor: Cursor, continueNow: Schema.Boolean }),
})
const Failed = Actor.command("Failed", { payload: Actor.DeadLetter(Collect) })

/** One deployment's durable collector cursor, including the hour to finish after a crash following source acknowledgement. */
export const CollectorActor = Actor.make("CollectorActor", {
  key: Schema.NonEmptyString,
  state: Actor.state({
    hour: Schema.NullOr(Schema.Int).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
    phase: Phase.pipe(Schema.withDecodingDefault(Effect.succeed("discover" as const))),
    afterTenant: Schema.NullOr(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
    busy: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  }),
  api: { Start },
  internal: { Poll, Progress, Failed },
  createdBy: Start,
  schedules: { "@every 1 minute": Poll },
  access: ({ caller }) => Effect.succeed(Predicate.isTagged(caller, "System")),
  jobs: {
    Collect: {
      job: Collect,
      onSuccess: Progress,
      onDeadLetter: Failed,
      concurrency: { perActor: 1 },
      retry: { times: 3 },
    },
  },
})

const sourceEvent = (event: JournalEvent): typeof MeterEvent.Type => {
  if (event.kind === "storage") {
    if (event.storageByteHours === null) throw new Error("Storage evidence has no measured bytes")
    return {
      kind: "storage",
      eventId: event.eventId,
      hour: DateTime.toEpochMillis(event.hour),
      storageByteHours: event.storageByteHours,
    }
  }
  return {
    kind: event.kind,
    eventId: event.eventId,
    hour: DateTime.toEpochMillis(event.hour),
    actorType: event.actorType,
    actorId: event.actorId,
    commandId: event.commandId,
    requestToken: event.requestToken,
  }
}

export const CollectorCommands = CollectorActor.toLayer({
  Start: Effect.fnUntraced(function* () {
    const turn = yield* CollectorActor.Turn
    if (turn.state.busy) return
    yield* turn.state.set({ busy: true })
    yield* turn.enqueue(
      Collect.make({
        hour: turn.state.hour,
        phase: turn.state.phase,
        afterTenant: turn.state.afterTenant,
      }),
    )
  }),
  Poll: Effect.fnUntraced(function* () {
    const turn = yield* CollectorActor.Turn
    if (turn.state.busy) return
    yield* turn.state.set({ busy: true })
    yield* turn.enqueue(
      Collect.make({
        hour: turn.state.hour,
        phase: turn.state.phase,
        afterTenant: turn.state.afterTenant,
      }),
    )
  }),
  Progress: Effect.fnUntraced(function* ({ cursor, continueNow }) {
    const turn = yield* CollectorActor.Turn
    yield* turn.state.set({ ...cursor, busy: continueNow })
    if (continueNow) yield* turn.enqueue(Collect.make(cursor))
  }),
  Failed: Effect.fnUntraced(function* () {
    yield* (yield* CollectorActor.Turn).state.set({ busy: false })
  }),
})

export const CollectorJobs = CollectorActor.toJobLayer(
  Effect.gen(function* () {
    const sources = yield* MeterSources
    return {
      Collect: Effect.fnUntraced(function* (cursor) {
        const { ref } = yield* CollectorActor.Executor
        const source = yield* sources.get(ref.id)
        const current = yield* source.currentHour
        yield* source.journal.sampleStorage(current)

        if (cursor.phase === "discover") {
          const earliest = yield* source.journal.earliestHour
          if (earliest === null) return { cursor, continueNow: false }
          return {
            cursor: {
              hour: DateTime.toEpochMillis(earliest),
              phase: "import" as const,
              afterTenant: null,
            },
            continueNow: true,
          }
        }

        if (cursor.hour === null)
          return yield* Effect.die(new Error("Collector cursor has no hour"))
        const hour = DateTime.makeUnsafe(cursor.hour)
        if (cursor.hour >= DateTime.toEpochMillis(current)) return { cursor, continueNow: false }

        if (cursor.phase === "import") {
          const page = yield* source.journal.sealAndPending(hour, 256)
          const grouped = new Map<string, Array<typeof MeterEvent.Type>>()
          for (const event of page.events) {
            if (event.deploymentId !== ref.id)
              return yield* Effect.die(new Error("Cell journal belongs to another deployment"))
            const events = grouped.get(event.tenant) ?? []
            events.push(sourceEvent(event))
            grouped.set(event.tenant, events)
          }
          for (const [tenant, events] of grouped) {
            const usage = yield* UsageActor.get(yield* usageKey(ref.id, tenant))
            const imported = yield* usage.Import({ events })
            if (imported.late.length > 0)
              return yield* Effect.die(
                new Error("Source evidence arrived after the hour was sealed"),
              )
          }
          yield* source.journal.ack(page.events.map(({ eventId }) => eventId))
          return {
            cursor: { ...cursor, phase: page.complete ? ("seal" as const) : ("import" as const) },
            continueNow: true,
          }
        }

        const tenants = yield* source.tenants(hour, cursor.afterTenant)
        const batch = tenants.slice(0, TENANTS_PER_JOB)
        for (const tenant of batch) {
          const usage = yield* UsageActor.get(yield* usageKey(ref.id, tenant))
          yield* usage.Seal({ hour: cursor.hour, completeThrough: cursor.hour + HOUR_MS })
        }
        return tenants.length > TENANTS_PER_JOB
          ? { cursor: { ...cursor, afterTenant: batch.at(-1)! }, continueNow: true }
          : {
              cursor: { hour: null, phase: "discover" as const, afterTenant: null },
              continueNow: true,
            }
      }),
    }
  }),
)

export const CollectorLive = (cells: ReadonlyArray<MeterCell>) =>
  Layer.mergeAll(CollectorCommands, CollectorJobs).pipe(Layer.provide(MeterSourcesLive(cells)))

export const startCollectors = (cells: ReadonlyArray<MeterCell>) =>
  Layer.effectDiscard(
    Effect.forEach(
      cells,
      (cell) =>
        CollectorActor.get(cell.deploymentId).pipe(
          Effect.flatMap((collector) => collector.Start()),
        ),
      { discard: true },
    ),
  )
