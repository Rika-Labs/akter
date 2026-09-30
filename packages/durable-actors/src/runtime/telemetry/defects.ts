import { Context, Effect, Schema } from "effect"

/**
 * One deterministic defect, as its failed turn span recorded it: the span's
 * name, trace, and attributes, and the cause the span carries.
 */
export const DefectRecord = Schema.Struct({
  span: Schema.String,
  traceId: Schema.String,
  spanId: Schema.String,
  atMs: Schema.Finite,
  tenant: Schema.String,
  actorType: Schema.String,
  actorId: Schema.String,
  command: Schema.String,
  commandId: Schema.String,
  trigger: Schema.String,
  cause: Schema.String,
})

/** The decoded shape of a `DefectRecord`. */
export type DefectRecord = typeof DefectRecord.Type

/** An array of defect records, as the operator read returns them. */
export const DefectRecords = Schema.Array(DefectRecord)

/** Narrows a defect listing; `limit` keeps the newest matches. */
interface DefectFilter {
  readonly actorType?: string | undefined
  readonly sinceMs?: number | undefined
  readonly limit?: number | undefined
}

/**
 * The defect spans this runner's exporter saw most recently, newest last.
 * The log is bounded and in memory: the telemetry backend keeps the history,
 * and a restarted runner starts empty.
 */
export class DefectLog extends Context.Service<
  DefectLog,
  {
    readonly record: (defect: DefectRecord) => Effect.Effect<void>
    readonly list: (filter: DefectFilter) => Effect.Effect<ReadonlyArray<DefectRecord>>
  }
>()("@durable-actors/core/runtime/telemetry/defects/DefectLog") {}

/** An in-memory `DefectLog` that keeps the newest `capacity` records. */
export const boundedDefectLog = (capacity: number) => {
  const records: Array<DefectRecord> = []

  return DefectLog.of({
    record: (defect) =>
      Effect.sync(() => {
        records.push(defect)

        if (records.length > capacity) records.splice(0, records.length - capacity)
      }),
    list: ({ actorType, sinceMs, limit }) =>
      Effect.sync(() => {
        const matching = records.filter(
          (defect) =>
            (actorType === undefined || defect.actorType === actorType) &&
            (sinceMs === undefined || defect.atMs >= sinceMs),
        )

        return limit === undefined ? matching : matching.slice(-limit)
      }),
  })
}
