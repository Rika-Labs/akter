import { checkWorkflows, formatIncompatibility } from "@durable-actors/core/runtime"
import type { Incompatibility } from "@durable-actors/core/runtime"
import { Effect, Schema } from "effect"
import { pathToFileURL } from "node:url"
import { parseFlags, UsageError } from "../../flags.ts"

/** Usage text for `durable workflows`. */
export const USAGE = "Usage: durable workflows check --entry <module> --database-url <url> [--json]"

/**
 * Parses `--entry <module> --database-url <url> [--json]`, the flags of every
 * command that loads an entry module against a database.
 */
export const parseCheck = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const parsed = yield* parseFlags({
      args,
      valued: ["--entry", "--database-url"],
      switches: ["--json"],
      maxPositional: 0,
    })

    const entry = parsed.flags.get("--entry")
    const databaseUrl = parsed.flags.get("--database-url")

    if (entry === undefined) return yield* UsageError.make({ message: "--entry is required" })

    if (databaseUrl === undefined)
      return yield* UsageError.make({ message: "--database-url is required" })

    return { entry, databaseUrl, json: parsed.switches.has("--json") }
  })

/** An entry module: its `actors` array of actor definitions. */
const Entry = Schema.Struct({
  actors: Schema.Array(
    Schema.Struct({ name: Schema.String, api: Schema.Record(Schema.String, Schema.Unknown) }),
  ),
})

const decodeEntry = Schema.decodeUnknownEffect(Entry)

const AnySchema = Schema.declare(Schema.isSchema)

/** The fields of a workflow member the check reads. */
const WorkflowDefinition = Schema.Struct({
  kind: Schema.Literal("workflow"),
  tag: Schema.String,
  input: AnySchema,
  output: AnySchema,
  errors: Schema.Array(AnySchema),
  versions: Schema.Record(
    Schema.String,
    Schema.Struct({ current: Schema.Finite, min: Schema.Finite }),
  ),
  registry: Schema.Struct({
    steps: Schema.declare((u): u is ReadonlyMap<unknown, unknown> => u instanceof Map),
  }),
})

const isWorkflowDefinition = Schema.is(WorkflowDefinition)

const isWorkflowKind = Schema.is(Schema.Struct({ kind: Schema.Literal("workflow") }))

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
    Effect.mapError(() =>
      UsageError.make({ message: `${entry} must export an \`actors\` array of actor definitions` }),
    ),
    Effect.flatMap(({ actors }) => {
      for (const actor of actors)
        for (const [name, member] of Object.entries(actor.api))
          if (isWorkflowKind(member) && !isWorkflowDefinition(member))
            return Effect.fail(
              UsageError.make({
                message: `${entry}: ${actor.name}.${name} is not an Actor.workflow definition`,
              }),
            )

      return Effect.succeed(actors)
    }),
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
