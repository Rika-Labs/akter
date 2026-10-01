import { DefectRecords, type DefectRecord } from "@rikalabs/akter/runtime"
import { Clock, Console, DateTime, Duration, Effect, Option, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { fail } from "../../failure.ts"
import { operatorFlags, operatorRequest, operatorToken } from "../operator/request.ts"

const units = { s: "seconds", m: "minutes", h: "hours", d: "days" } as const

/** `1h`, `30m`, `2d`, `45s`, or any Effect duration such as `90 minutes`. */
const parseSince = (value: string) => {
  const compact = /^(\d+)([smhd])$/.exec(value)

  return Duration.fromInput(
    (compact === null
      ? value
      : `${compact[1]} ${units[compact[2] as keyof typeof units]}`) as Duration.Input,
  )
}

const decodeDefects = Schema.decodeUnknownEffect(DefectRecords)

const flags = {
  ...operatorFlags,
  tenant: Flag.String("tenant").pipe(
    Flag.withDefault("*"),
    Flag.withDescription(
      "The tenant to read, or * for every tenant the operator's grant covers (default *)",
    ),
  ),
  actor: Flag.String("actor").pipe(
    Flag.optional,
    Flag.withDescription("Only defects of this actor type"),
  ),
  since: Flag.String("since").pipe(
    Flag.filterMap(parseSince, () => 'a duration such as 1h, 30m, 2d, 45s or "90 minutes"'),
    Flag.optional,
    Flag.withDescription("Only defects this recent: 1h, 30m, 2d, 45s, or any duration"),
  ),
  limit: Flag.Int("limit").pipe(
    Flag.filter(
      (limit) => limit >= 1 && limit <= 1000,
      () => "an integer from 1 to 1000",
    ),
    Flag.optional,
    Flag.withDescription("At most this many of the newest defects, 1 to 1000"),
  ),
}

/** What `defects list` reads. */
export interface ListOptions {
  readonly urls: ReadonlyArray<string>
  /** A tenant, or `*` for every tenant the operator's grant covers. */
  readonly tenant: string
  readonly actor: string | undefined
  readonly sinceMs: number | undefined
  readonly limit: number | undefined
}

/**
 * Reads each runner's `GET /operator/defects` and merges them oldest first. Each
 * runner keeps only its own recent defect spans, so name every runner of the
 * deployment; older history is in the telemetry backend.
 */
export const listDefects = Effect.fnUntraced(function* (
  options: ListOptions,
  token: string | undefined,
) {
  const read = (url: string) => {
    const query = new URLSearchParams({ tenant: options.tenant })

    if (options.actor !== undefined) query.set("actor", options.actor)

    if (options.sinceMs !== undefined) query.set("sinceMs", String(Math.floor(options.sinceMs)))

    if (options.limit !== undefined) query.set("limit", String(options.limit))

    return operatorRequest({ url, path: `/operator/defects?${query}`, token }).pipe(
      Effect.flatMap(decodeDefects),
    )
  }

  const each = yield* Effect.forEach(options.urls, read, { concurrency: "unbounded" })
  const merged = each.flat().toSorted((a, b) => a.atMs - b.atMs)

  return options.limit === undefined ? merged : merged.slice(-options.limit)
})

/** One line per defect: time, actor, command and command id, trace, and the cause's first line. */
export const formatDefects = ({
  defects,
  json,
}: {
  readonly defects: ReadonlyArray<DefectRecord>
  readonly json: boolean
}) => {
  if (json) return JSON.stringify(defects, null, 2)

  if (defects.length === 0) return "No defects."

  return defects
    .map((defect) =>
      [
        DateTime.formatIso(DateTime.makeUnsafe(defect.atMs)),
        `${defect.actorType}/${defect.actorId}`,
        `${defect.command} ${defect.commandId}`,
        `tenant=${defect.tenant}`,
        `trace=${defect.traceId}`,
        defect.cause.split("\n")[0] ?? "",
      ].join("  "),
    )
    .join("\n")
}

/** `durable defects list`: every named runner's recent defect spans, merged oldest first. */
export const listCommand = Command.make("list", flags, (options) =>
  Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis
    const token = yield* operatorToken(options.tokenEnv)

    const defects = yield* listDefects(
      {
        urls: options.urls,
        tenant: options.tenant,
        actor: Option.getOrUndefined(options.actor),
        sinceMs: Option.getOrUndefined(
          Option.map(options.since, (since) => nowMs - Duration.toMillis(since)),
        ),
        limit: Option.getOrUndefined(options.limit),
      },
      token,
    )

    yield* Console.log(formatDefects({ defects, json: options.json }))
  }).pipe(
    Effect.catchTags({
      RunnerUnreachable: (error) =>
        fail({
          reason: error._tag,
          message: `Cannot read defects from ${error.url}: ${error.message}`,
        }),
      OperatorRefused: (error) =>
        fail({
          reason: error._tag,
          message: `Refused (${error.status}): ${error.body}`,
          exitCode: 1,
        }),
      SchemaError: (error) =>
        fail({ reason: error._tag, message: `Unexpected answer: ${error.message}` }),
      ConfigError: (error) =>
        fail({ reason: error._tag, message: `Cannot read the operator token: ${error.message}` }),
    }),
  ),
).pipe(
  Command.withDescription(
    "List recent defects from each runner named; each keeps only its own recent defect spans",
  ),
)
