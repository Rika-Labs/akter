import { Inspection } from "@durable-actors/core/client"
import { Effect, Schema, Struct } from "effect"
import { Command, Flag } from "effect/cli"
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

/** The parts of the operator's actor page the human output prints. */
export const ActorPage = Schema.Struct({
  actor: Inspection.ActorRow.mapFields(
    Struct.pick(["actorType", "actorId", "generation", "lastEventSequence"]),
  ),
  state: Schema.Array(
    Inspection.ActorDetail.fields.state.value.mapFields(Struct.pick(["key", "value"])),
  ),
  receipts: Schema.Array(
    Inspection.OperatorActorDetail.fields.receipts.value.mapFields(
      Struct.pick(["commandId", "command", "outcomeTag", "outcome"]),
    ),
  ),
  deadLetters: Schema.Array(
    Inspection.DeadLetterRow.mapFields(
      Struct.pick(["jobId", "job", "attempts", "ambiguous", "cause"]),
    ),
  ),
  totals: Inspection.ActorDetail.fields.totals,
})

const decodeActorPage = Schema.decodeUnknownEffect(ActorPage)

const shown = (value: Inspection.Decoded | null | undefined) =>
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
    `totals  receipts ${page.totals.receipts}  events ${page.totals.events}  outbox ${page.totals.outbox}  jobs ${page.totals.jobs}  dead letters ${page.totals.deadLetters}  workflows ${page.totals.workflows}`,
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
              `  ${letter.jobId}  ${letter.job}  attempts ${letter.attempts}${letter.ambiguous ? "  ambiguous" : ""}  ${letter.cause.split("\n")[0] ?? ""}`,
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
