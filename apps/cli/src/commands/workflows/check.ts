import { Database, checkWorkflows, formatIncompatibility } from "@rikalabs/akter/runtime"
import type { Incompatibility } from "@rikalabs/akter/runtime"
import { Console, Effect, Layer, Schema, type Crypto } from "effect"
import { Command, Flag } from "effect/cli"
import type { SqlClient, SqlError } from "effect/sql"
import { pathToFileURL } from "node:url"
import { CommandFailed, UsageError, fail } from "../../failure.ts"
import { PlatformCrypto } from "../../platform.ts"

/** Flags of the commands that load an entry module and read its database. */
export const entryFlags = {
  entry: Flag.File("entry", { mustExist: true }).pipe(
    Flag.withDescription("The entry module; it exports an `actors` array of actor definitions"),
  ),
  databaseUrl: Flag.Redacted("database-url").pipe(
    Flag.withDescription("The application's Postgres URL"),
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Print the report as JSON"),
  ),
}

/**
 * Loads the entry's actors, then runs `run` against its Postgres and prints
 * the report; a report with exit code 1 ends the command with it. `reading`
 * names what a database failure could not read.
 */
export const entryCommand = ({
  options,
  reading,
  run,
}: {
  readonly options: Command.Command.Config.Infer<typeof entryFlags>
  readonly reading: string
  readonly run: (
    actors: ReadonlyArray<{ readonly name: string; readonly api: object }>,
  ) => Effect.Effect<
    { readonly output: string; readonly exitCode: number },
    SqlError.SqlError,
    SqlClient.SqlClient | Crypto.Crypto
  >
}): Effect.Effect<void, CommandFailed> =>
  Effect.gen(function* () {
    const module = yield* loadEntry(options.entry)
    const actors = yield* actorsOf({ module, entry: options.entry })

    const services = yield* Layer.build(
      Database.postgres({ url: options.databaseUrl }).pipe(
        Layer.provideMerge(PlatformCrypto.layer),
      ),
    )

    const { output, exitCode } = yield* run(actors).pipe(Effect.provideContext(services))

    yield* Console.log(output)

    if (exitCode !== 0) return yield* CommandFailed.make({ exitCode, reason: "Refused" })
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      SqlError: (error) =>
        fail({ reason: error._tag, message: `Cannot read ${reading}: ${error.message}` }),
      UsageError: (error) => fail({ reason: error._tag, message: error.message }),
    }),
  )

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
  payload: AnySchema,
  success: AnySchema,
  error: AnySchema,
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

/** `akter workflows check`: exits 1 when an open execution needs a step the entry removed. */
export const checkCommand = Command.make("check", entryFlags, (options) =>
  entryCommand({
    options,
    reading: "workflow state",
    run: (actors) => check({ actors, json: options.json }),
  }),
).pipe(
  Command.withDescription(
    "Compare the entry's workflows with every open execution, read-only; exit 1 when a deploy would be refused",
  ),
)
