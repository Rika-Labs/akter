import { Effect, Option, Schema } from "effect"
import { UsageError } from "../../flags.ts"
import { operatorRequest, parseOperatorFlags } from "../operator/request.ts"

export const USAGE =
  "Usage: durable subscriptions list --lagging --url <runner> --tenant <tenant> [--min-attempts <n>] [--limit <n>] [--token-env <name>] [--json]"

const Count = (maximum: number) =>
  Schema.FiniteFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum }))

const decodeAttempts = Schema.decodeUnknownOption(Count(1_000_000))

const decodeLimit = Schema.decodeUnknownOption(Count(1000))

/** Parses the arguments after `subscriptions list`. */
export const parseList = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const parsed = yield* parseOperatorFlags({
      args,
      valued: ["--min-attempts", "--limit"],
      switches: ["--lagging"],
    })

    if (parsed.positional.length > 0)
      return yield* UsageError.make({ message: "list takes flags only" })

    if (!parsed.switches.has("--lagging"))
      return yield* UsageError.make({ message: "--lagging is required: it is the only listing" })

    if (parsed.tenant === undefined)
      return yield* UsageError.make({ message: "--tenant is required" })

    const minAttempts = parsed.flags.get("--min-attempts")
    const limit = parsed.flags.get("--limit")

    if (minAttempts !== undefined && Option.isNone(decodeAttempts(minAttempts)))
      return yield* UsageError.make({ message: "--min-attempts must be a positive integer" })

    if (limit !== undefined && Option.isNone(decodeLimit(limit)))
      return yield* UsageError.make({ message: "--limit must be an integer from 1 to 1000" })

    return { ...parsed, tenant: parsed.tenant, minAttempts, limit }
  })

/** Lists the rows whose deliveries keep failing, through the first runner named. */
export const list = ({
  options,
  token,
}: {
  readonly options: Effect.Success<ReturnType<typeof parseList>>
  readonly token: string | undefined
}) => {
  const params = new URLSearchParams({ tenant: options.tenant })

  if (options.minAttempts !== undefined) params.set("minAttempts", options.minAttempts)

  if (options.limit !== undefined) params.set("limit", options.limit)

  return operatorRequest({
    url: options.urls[0]!,
    path: `/operator/subscriptions/lagging?${params}`,
    token,
  })
}

const Row = Schema.Struct({
  sourceType: Schema.String,
  sourceId: Schema.String,
  subscriberType: Schema.String,
  subscription: Schema.String,
  subscriberId: Schema.String,
  delivered: Schema.String,
  head: Schema.String,
  lag: Schema.String,
  attempts: Schema.Finite,
  lastError: Schema.String,
})

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row))

/** The failing rows as `durable subscriptions list` prints them, one per row plus its last error. */
export const formatLagging = (answer: Schema.Json) =>
  Effect.map(decodeRows(answer), (rows) =>
    rows.length === 0
      ? "no lagging subscriptions"
      : rows
          .flatMap((row) => [
            `${row.sourceType}/${row.sourceId} -> ${row.subscriberType}.${row.subscription}/${row.subscriberId}  delivered ${row.delivered} of ${row.head}  lag ${row.lag}  attempts ${row.attempts}`,
            `  ${row.lastError.split("\n")[0] ?? ""}`,
          ])
          .join("\n"),
  )
