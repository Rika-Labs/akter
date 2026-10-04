import type { AnyFleetView } from "@rikalabs/akter"
import { Database, rebuildFleetView, setupFleet } from "@rikalabs/akter/runtime"
import { BunCrypto } from "@effect/platform-bun"
import { Console, Effect, Layer, Predicate, type Redacted } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import type { SqlClient } from "effect/sql"
import { CommandFailed, UsageError, fail } from "../../failure.ts"
import { loadEntry } from "../workflows/check.ts"

const isView = (value: unknown): value is AnyFleetView =>
  Predicate.hasProperty(value, "definitionHash") &&
  Predicate.hasProperty(value, "groupColumns") &&
  Predicate.hasProperty(value, "table")

/** The fleet views a loaded entry module exports as `fleet`. */
export const viewsOf = ({ module, entry }: { readonly module: object; readonly entry: string }) => {
  const fleet = (module as { readonly fleet?: unknown }).fleet

  return Array.isArray(fleet) && fleet.length > 0 && fleet.every(isView)
    ? Effect.succeed(fleet as ReadonlyArray<AnyFleetView>)
    : Effect.fail(
        UsageError.make({ message: `${entry} must export a \`fleet\` array of Fleet.view values` }),
      )
}

/** Runs `fleet setup` against the database in context and says what it changed. */
export const setup = (views: ReadonlyArray<AnyFleetView>) =>
  setupFleet(views).pipe(
    Effect.map((result) =>
      [
        `Full replica identity and publication durable_fleet: ${result.sources.join(", ")}`,
        `Replication slot durable_fleet: ${result.slot}`,
      ].join("\n"),
    ),
  )

/** Runs `fleet rebuild`: exit 1 when no runtime has registered `view`. */
export const rebuild = (view: string) =>
  rebuildFleetView(view).pipe(
    Effect.map((found) =>
      found
        ? { output: `${view} is building; the maintainer rebuilds it from its source`, exitCode: 0 }
        : { output: `No fleet view ${view} is registered on this database`, exitCode: 1 },
    ),
  )

/** Runs `run` against the Postgres at `databaseUrl`, prints its output, and ends with its exit code. */
const onDatabase = <E, R>(
  databaseUrl: Redacted.Redacted<string>,
  run: Effect.Effect<
    { readonly output: string; readonly exitCode: number },
    E,
    R | SqlClient.SqlClient
  >,
) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      Database.postgres({ url: databaseUrl }).pipe(Layer.provideMerge(BunCrypto.layer)),
    )

    const { output, exitCode } = yield* run.pipe(Effect.provideContext(services))

    yield* Console.log(output)

    if (exitCode !== 0) return yield* CommandFailed.make({ exitCode, reason: "Refused" })
  }).pipe(Effect.scoped)

const databaseUrl = Flag.Redacted("database-url").pipe(
  Flag.withDescription("The application's Postgres URL"),
)

/** `akter fleet setup`: full replica identity, publication, and slot for the entry's views. */
export const setupCommand = Command.make(
  "setup",
  {
    entry: Flag.File("entry", { mustExist: true }).pipe(
      Flag.withDescription("The entry module; it exports a `fleet` array of Fleet.view values"),
    ),
    databaseUrl,
  },
  (options) =>
    Effect.gen(function* () {
      const views = yield* viewsOf({
        module: yield* loadEntry(options.entry),
        entry: options.entry,
      })

      return yield* onDatabase(
        options.databaseUrl,
        setup(views).pipe(Effect.map((output) => ({ output, exitCode: 0 }))),
      )
    }).pipe(
      Effect.catchTags({
        SqlError: (error) =>
          fail({ reason: error._tag, message: `Cannot set up fleet views: ${error.message}` }),
        FleetSetupRefused: (error) => fail({ reason: error._tag, message: error.message }),
        UsageError: (error) => fail({ reason: error._tag, message: error.message }),
      }),
    ),
).pipe(
  Command.withDescription(
    "Give the entry's fleet view sources full replica identity, publish them, and create the logical slot; needs wal_level=logical",
  ),
)

/** `akter fleet rebuild <View>`: clears a view's error and rebuilds it; exits 1 for an unknown view. */
export const rebuildCommand = Command.make(
  "rebuild",
  {
    view: Argument.String("view").pipe(Argument.withDescription("The fleet view to rebuild")),
    databaseUrl,
  },
  (options) =>
    onDatabase(options.databaseUrl, rebuild(options.view)).pipe(
      Effect.catchTags({
        SqlError: (error) =>
          fail({ reason: error._tag, message: `Cannot rebuild ${options.view}: ${error.message}` }),
      }),
    ),
).pipe(
  Command.withDescription(
    "Rebuild a fleet view from its source, clearing its error; exit 1 when no runtime registered it",
  ),
)
