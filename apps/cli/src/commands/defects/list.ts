import { DefectRecords, type DefectRecord } from "@durable-actors/core/runtime"
import { DateTime, Duration, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { RunnerUnreachable, TOKEN_ENV } from "../operator/request.ts"
import { UsageError } from "../workflows/check.ts"

export const USAGE =
  "Usage: durable defects list --url <runner> [--url <runner> ...] [--tenant <tenant>] [--actor <type>] [--since <duration>] [--limit <n>] [--token-env <name>] [--json]"

export interface ListOptions {
  readonly urls: ReadonlyArray<string>
  /** A tenant, or `*` for every tenant the operator's grant covers. */
  readonly tenant: string
  readonly actor: string | undefined
  readonly sinceMs: number | undefined
  readonly limit: number | undefined
  readonly tokenEnv: string
  readonly json: boolean
}

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

const Limit = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 1000 }),
)

const decodeLimit = Schema.decodeUnknownOption(Limit)

/** Parses the arguments after `defects list`; `nowMs` anchors `--since`. */
export const parseList = ({
  args,
  nowMs,
}: {
  readonly args: ReadonlyArray<string>
  readonly nowMs: number
}) =>
  Effect.gen(function* () {
    const urls: Array<string> = []
    let actor: string | undefined
    let sinceMs: number | undefined
    let limit: number | undefined
    let tokenEnv = TOKEN_ENV
    let tenant = "*"
    let json = false

    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!

      if (arg === "--json") {
        json = true
        continue
      }

      if (!["--url", "--tenant", "--actor", "--since", "--limit", "--token-env"].includes(arg))
        return yield* UsageError.make({ message: `Unknown argument: ${arg}` })

      const value = args[++index]

      if (value === undefined) return yield* UsageError.make({ message: `${arg} needs a value` })

      if (arg === "--url") urls.push(value.replace(/\/+$/, ""))
      else if (arg === "--tenant") tenant = value
      else if (arg === "--actor") actor = value
      else if (arg === "--token-env") tokenEnv = value
      else if (arg === "--limit") {
        const parsed = decodeLimit(value)

        if (Option.isNone(parsed))
          return yield* UsageError.make({ message: "--limit must be an integer from 1 to 1000" })

        limit = parsed.value
      } else {
        const since = parseSince(value)

        if (Option.isNone(since))
          return yield* UsageError.make({ message: `--since is not a duration: ${value}` })

        sinceMs = nowMs - Duration.toMillis(since.value)
      }
    }

    if (urls.length === 0) return yield* UsageError.make({ message: "--url is required" })

    return { urls, tenant, actor, sinceMs, limit, tokenEnv, json } satisfies ListOptions
  })

/**
 * Reads each runner's `GET /operator/defects` and merges them oldest first. Each
 * runner keeps only its own recent defect spans, so name every runner of the
 * deployment; older history is in the telemetry backend.
 */
export const listDefects = Effect.fnUntraced(function* (
  options: Omit<ListOptions, "tokenEnv" | "json">,
  token: string | undefined,
) {
  const client = yield* HttpClient.HttpClient

  const read = (url: string) => {
    const query = new URLSearchParams({ tenant: options.tenant })

    if (options.actor !== undefined) query.set("actor", options.actor)

    if (options.sinceMs !== undefined) query.set("sinceMs", String(Math.floor(options.sinceMs)))

    if (options.limit !== undefined) query.set("limit", String(options.limit))

    const request = HttpClientRequest.get(`${url}/operator/defects?${query}`).pipe(
      token === undefined ? (same) => same : HttpClientRequest.bearerToken(token),
    )

    return client.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(DefectRecords)),
      Effect.mapError((error) => RunnerUnreachable.make({ url, message: error.message })),
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
