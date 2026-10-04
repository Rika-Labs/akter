import { Effect, Option, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { operatorCommand, operatorFlags, operatorRequest, tenant } from "../operator/request.ts"

const count = (name: string, maximum: number, description: string) =>
  Flag.Int(name).pipe(
    Flag.filter(
      (value) => value >= 1 && value <= maximum,
      () => `an integer from 1 to ${maximum}`,
    ),
    Flag.optional,
    Flag.withDescription(description),
  )

const flags = {
  lagging: Flag.Boolean("lagging").pipe(
    Flag.withDescription(
      "List the rows whose deliveries keep failing; the only listing, so required",
    ),
  ),
  tenant,
  minAttempts: count(
    "min-attempts",
    1_000_000,
    "Only rows with at least this many failed attempts",
  ),
  limit: count("limit", 1000, "At most this many rows, 1 to 1000"),
  ...operatorFlags,
}

/** Parsed arguments of `subscriptions list`. */
export type ListOptions = Command.Command.Config.Infer<typeof flags>

/** Lists the rows whose deliveries keep failing, through the first runner named. */
export const list = ({
  options,
  token,
}: {
  readonly options: ListOptions
  readonly token: string | undefined
}) => {
  const params = new URLSearchParams({ tenant: options.tenant })

  if (Option.isSome(options.minAttempts))
    params.set("minAttempts", String(options.minAttempts.value))

  if (Option.isSome(options.limit)) params.set("limit", String(options.limit.value))

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

/** The failing rows as `akter subscriptions list` prints them, one per row plus its last error. */
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

/** `akter subscriptions list --lagging`: the rows whose deliveries keep failing. */
export const listCommand = Command.make("list", flags, (options) =>
  operatorCommand({ options, request: list, format: formatLagging }),
).pipe(
  Command.withDescription(
    "List subscription rows whose deliveries keep failing, with their lag and last error",
  ),
)
