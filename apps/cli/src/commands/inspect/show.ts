import { Effect, Option, Schema } from "effect"
import { UsageError } from "../../flags.ts"
import { operatorRequest, parseActor, parseOperatorFlags } from "../operator/request.ts"

/** Usage text for `durable inspect`. */
export const USAGE =
  "Usage: durable inspect <Type>/<id> --url <runner> --tenant <tenant> [--receipts <n>] [--token-env <name>] [--json]"

const Count = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 1000 }),
)

const decodeCount = Schema.decodeUnknownOption(Count)

/** Parses the arguments after `inspect`. */
export const parseInspect = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const flags = yield* parseOperatorFlags({ args, valued: ["--receipts"], switches: [] })
    const actor = yield* parseActor(flags.positional[0])

    if (flags.positional.length > 1)
      return yield* UsageError.make({ message: `Unexpected argument: ${flags.positional[1]}` })

    if (flags.tenant === undefined)
      return yield* UsageError.make({ message: "--tenant is required" })

    const receipts = flags.flags.get("--receipts")
    const limit = receipts === undefined ? Option.some(20) : decodeCount(receipts)

    if (Option.isNone(limit))
      return yield* UsageError.make({ message: "--receipts must be an integer from 1 to 1000" })

    return { ...flags, ...actor, tenant: flags.tenant, limit: limit.value }
  })

const Decoded = Schema.Union([
  Schema.Struct({ json: Schema.Json }),
  Schema.Struct({ undecodable: Schema.String }),
])

/** The parts of the operator's actor page the human output prints. */
export const ActorPage = Schema.Struct({
  actor: Schema.Struct({
    actorType: Schema.String,
    actorId: Schema.String,
    generation: Schema.Finite,
    lastEventSequence: Schema.Finite,
  }),
  state: Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.NullOr(Decoded) })),
  receipts: Schema.Array(
    Schema.Struct({
      commandId: Schema.String,
      command: Schema.String,
      outcomeTag: Schema.NullOr(Schema.String),
      outcome: Schema.optionalKey(Schema.NullOr(Decoded)),
    }),
  ),
  deadLetters: Schema.Array(
    Schema.Struct({
      effectId: Schema.String,
      effect: Schema.String,
      attempts: Schema.Finite,
      ambiguous: Schema.Boolean,
      cause: Schema.String,
    }),
  ),
  totals: Schema.Struct({
    receipts: Schema.Finite,
    events: Schema.Finite,
    outbox: Schema.Finite,
    effects: Schema.Finite,
    deadLetters: Schema.Finite,
    workflows: Schema.Finite,
  }),
})

const decodeActorPage = Schema.decodeUnknownEffect(ActorPage)

const shown = (value: typeof Decoded.Type | null | undefined) =>
  value === undefined
    ? "(outcome needs receipts.read)"
    : value === null
      ? "null"
      : "json" in value
        ? JSON.stringify(value.json)
        : `(undecodable: ${value.undecodable})`

/** One actor as `durable inspect` prints it. */
export const formatActor = (page: typeof ActorPage.Type) =>
  [
    `${page.actor.actorType}/${page.actor.actorId}  generation ${page.actor.generation}  events through ${page.actor.lastEventSequence}`,
    `totals  receipts ${page.totals.receipts}  events ${page.totals.events}  outbox ${page.totals.outbox}  effects ${page.totals.effects}  dead letters ${page.totals.deadLetters}  workflows ${page.totals.workflows}`,
    "state",
    ...page.state.map(({ key, value }) => `  ${key} = ${shown(value)}`),
    "receipts (newest first)",
    ...page.receipts.map(
      (receipt) =>
        `  ${receipt.command} ${receipt.commandId}  ${receipt.outcomeTag ?? "?"}  ${shown(receipt.outcome)}`,
    ),
    ...(page.deadLetters.length === 0
      ? []
      : [
          "dead letters",
          ...page.deadLetters.map(
            (letter) =>
              `  ${letter.effectId}  ${letter.effect}  attempts ${letter.attempts}${letter.ambiguous ? "  ambiguous" : ""}  ${letter.cause.split("\n")[0] ?? ""}`,
          ),
        ]),
  ].join("\n")

/** Reads one actor through the first runner named. */
export const inspect = ({
  options,
  token,
}: {
  readonly options: Effect.Success<ReturnType<typeof parseInspect>>
  readonly token: string | undefined
}) =>
  operatorRequest({
    url: options.urls[0]!,
    path: `/operator/actors/${encodeURIComponent(options.actorType)}/${encodeURIComponent(options.actorId)}?${new URLSearchParams({ tenant: options.tenant, limit: String(options.limit) })}`,
    token,
  })

/** Decodes the runner's actor page and formats it as `durable inspect` prints it. */
export const formatInspection = (answer: Schema.Json) =>
  Effect.map(decodeActorPage(answer), formatActor)
