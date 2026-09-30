import { Effect, Schema } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import {
  actorArgument,
  operatorCommand,
  operatorFlags,
  operatorRequest,
  tenant,
} from "../operator/request.ts"

const flags = {
  actor: actorArgument,
  tenant,
  limit: Flag.Int("receipts").pipe(
    Flag.filter(
      (count) => count >= 1 && count <= 1000,
      () => "an integer from 1 to 1000",
    ),
    Flag.withDefault(20),
    Flag.withDescription("How many of the newest receipts to show, 1 to 1000 (default 20)"),
  ),
  ...operatorFlags,
}

/** Parsed arguments of `inspect`. */
export type InspectOptions = Command.Command.Config.Infer<typeof flags>

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
  readonly options: InspectOptions
  readonly token: string | undefined
}) =>
  operatorRequest({
    url: options.urls[0]!,
    path: `/operator/actors/${encodeURIComponent(options.actor.actorType)}/${encodeURIComponent(options.actor.actorId)}?${new URLSearchParams({ tenant: options.tenant, limit: String(options.limit) })}`,
    token,
  })

/** Decodes the runner's actor page and formats it as `durable inspect` prints it. */
export const formatInspection = (answer: Schema.Json) =>
  Effect.map(decodeActorPage(answer), formatActor)

/** `durable inspect <Type>/<id>`: one actor's state, newest receipts, and dead letters. */
export const inspectCommand = Command.make("inspect", flags, (options) =>
  operatorCommand({ options, request: inspect, format: formatInspection }),
).pipe(
  Command.withDescription(
    "Read one actor's state, newest receipts, and dead letters through the first runner named",
  ),
)
