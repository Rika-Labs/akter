import { Seed, SeedJson } from "@durable-actors/core/runtime"
import { Effect, FileSystem, Schema } from "effect"
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
  output: Flag.File("output").pipe(
    Flag.withDescription("The seed file to create; an existing file is never replaced"),
  ),
  ...operatorFlags,
}

/** Parsed arguments of `export`. */
export type ExportOptions = Command.Command.Config.Infer<typeof flags>

const ExportAnswer = Schema.Struct({
  output: Schema.String,
  actor: Schema.String,
  state: Schema.Finite,
  intents: Schema.Finite,
  effects: Schema.Finite,
  omitted: Schema.Struct({
    receipts: Schema.Finite,
    events: Schema.Finite,
    workflows: Schema.Finite,
    deadLetters: Schema.Finite,
    tableRows: Schema.Finite,
    blobs: Schema.Finite,
  }),
})

/**
 * Reads one actor's seed through the first runner named and writes it to
 * `output`. The file is created for its owner alone and never replaces an
 * existing one, because a seed holds the actor's data. The answer counts what
 * the file carries and what it leaves out, and never repeats a value.
 */
export const exportSeed = Effect.fnUntraced(function* ({
  options,
  token,
}: {
  readonly options: ExportOptions
  readonly token: string | undefined
}) {
  const answer = yield* operatorRequest({
    url: options.urls[0]!,
    path: `/operator/actors/${encodeURIComponent(options.actor.actorType)}/${encodeURIComponent(options.actor.actorId)}/export?${new URLSearchParams({ tenant: options.tenant })}`,
    token,
  })

  const seed = yield* Schema.decodeUnknownEffect(Seed)(answer)
  const fs = yield* FileSystem.FileSystem

  yield* fs.writeFileString(
    options.output,
    `${yield* Schema.encodeEffect(SeedJson)(seed).pipe(Effect.orDie)}\n`,
    { flag: "wx", mode: 0o600 },
  )

  return {
    output: options.output,
    actor: `${seed.actor.type}/${seed.actor.id}`,
    state: Object.keys(seed.state).length,
    intents: seed.intents.length,
    effects: seed.effects.length,
    omitted: seed.omitted,
  } satisfies typeof ExportAnswer.Type
})

/** The one line `durable export` prints for its answer. */
export const formatExport = (answer: Schema.Json) =>
  Effect.map(Schema.decodeUnknownEffect(ExportAnswer)(answer), (exported) =>
    [
      `Exported ${exported.actor} to ${exported.output}`,
      `carries ${exported.state} state keys, ${exported.intents} pending intents, ${exported.effects} pending effects`,
      `omits ${exported.omitted.receipts} receipts, ${exported.omitted.events} events, ${exported.omitted.workflows} workflows, ${exported.omitted.deadLetters} dead letters, ${exported.omitted.tableRows} owned-table rows, ${exported.omitted.blobs} blob entries`,
    ].join("\n"),
  )

/** `durable export <Type>/<id> --output <file>`: one actor's seed, written to a new file. */
export const exportCommand = Command.make("export", flags, (options) =>
  operatorCommand({ options, request: exportSeed, format: formatExport }),
).pipe(
  Command.withDescription(
    "Write one actor's state and pending intents and effects to a new seed file, through the first runner named",
  ),
)
