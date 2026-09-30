import { Seed, SeedJson } from "@durable-actors/core/runtime"
import { Effect, FileSystem, Schema } from "effect"
import { UsageError } from "../../flags.ts"
import { operatorRequest, parseActor, parseOperatorFlags } from "../operator/request.ts"

/** Usage text for `durable export`. */
export const USAGE =
  "Usage: durable export <Type>/<id> --url <runner> --tenant <tenant> --output <file> [--token-env <name>] [--json]"

/** Parses the arguments after `export`. */
export const parseExport = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const flags = yield* parseOperatorFlags({ args, valued: ["--output"], switches: [] })
    const actor = yield* parseActor(flags.positional[0])
    const output = flags.flags.get("--output")

    if (flags.positional.length > 1)
      return yield* UsageError.make({ message: `Unexpected argument: ${flags.positional[1]}` })

    if (flags.tenant === undefined)
      return yield* UsageError.make({ message: "--tenant is required" })

    if (output === undefined || output.length === 0)
      return yield* UsageError.make({ message: "--output is required" })

    return { ...flags, ...actor, tenant: flags.tenant, output }
  })

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
  readonly options: Effect.Success<ReturnType<typeof parseExport>>
  readonly token: string | undefined
}) {
  const answer = yield* operatorRequest({
    url: options.urls[0]!,
    path: `/operator/actors/${encodeURIComponent(options.actorType)}/${encodeURIComponent(options.actorId)}/export?${new URLSearchParams({ tenant: options.tenant })}`,
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
