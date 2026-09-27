import { checkWorkflows, formatIncompatibility } from "@durable-actors/core/runtime"
import type { Incompatibility } from "@durable-actors/core/runtime"
import { Effect, Schema } from "effect"
import { pathToFileURL } from "node:url"

export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String,
}) {}

export const USAGE = "Usage: durable workflows check --entry <module> --database-url <url> [--json]"

export interface CheckOptions {
  readonly entry: string
  readonly databaseUrl: string
  readonly json: boolean
}

/** Parses the arguments after `workflows check`. */
export const parseCheck = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    let entry: string | undefined
    let databaseUrl: string | undefined
    let json = false

    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!

      if (arg === "--json") json = true
      else if (arg === "--entry" || arg === "--database-url") {
        const value = args[++index]

        if (value === undefined) return yield* UsageError.make({ message: `${arg} needs a value` })

        if (arg === "--entry") entry = value
        else databaseUrl = value
      } else return yield* UsageError.make({ message: `Unknown argument: ${arg}` })
    }

    if (entry === undefined) return yield* UsageError.make({ message: "--entry is required" })

    if (databaseUrl === undefined)
      return yield* UsageError.make({ message: "--database-url is required" })

    return { entry, databaseUrl, json } satisfies CheckOptions
  })

/** An entry module: its `actors` array of actor definitions. */
const Entry = Schema.Struct({
  actors: Schema.Array(
    Schema.Struct({ name: Schema.String, api: Schema.Record(Schema.String, Schema.Unknown) }),
  ),
})

const decodeEntry = Schema.decodeUnknownEffect(Entry)

/** Imports the entry module at `entry`; a missing or broken module is a usage error. */
export const loadEntry = (entry: string) =>
  Effect.tryPromise({
    try: (): Promise<object> => import(pathToFileURL(entry).href),
    catch: (cause) =>
      UsageError.make({
        message: `Cannot load ${entry}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })

/** The actors a loaded entry module exports. */
export const actorsOf = ({ module, entry }: { readonly module: object; readonly entry: string }) =>
  decodeEntry(module).pipe(
    Effect.map(({ actors }) => actors),
    Effect.mapError(() =>
      UsageError.make({ message: `${entry} must export an \`actors\` array of actor definitions` }),
    ),
  )

/** What the check prints and the exit code it ends with. */
export const report = ({
  incompatibilities,
  json,
}: {
  readonly incompatibilities: ReadonlyArray<Incompatibility>
  readonly json: boolean
}) => ({
  incompatibilities,
  output: json
    ? JSON.stringify({ compatible: incompatibilities.length === 0, incompatibilities }, null, 2)
    : incompatibilities.length === 0
      ? "Workflows are compatible with every open execution"
      : [
          ...incompatibilities.map(formatIncompatibility),
          `${incompatibilities.length} incompatibilit${
            incompatibilities.length === 1 ? "y" : "ies"
          }; deploy refused (exit 1)`,
        ].join("\n"),
  exitCode: incompatibilities.length === 0 ? 0 : 1,
})

/** Compares `actors` with every open execution in the database, read-only. */
export const check = ({
  actors,
  json,
}: {
  readonly actors: ReadonlyArray<{ readonly name: string; readonly api: object }>
  readonly json: boolean
}) =>
  checkWorkflows(actors).pipe(
    Effect.map((incompatibilities) => report({ incompatibilities, json })),
  )
