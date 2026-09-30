import type { AnyFleetView } from "@durable-actors/core"
import { rebuildFleetView, setupFleet } from "@durable-actors/core/runtime"
import { Effect, Predicate } from "effect"
import { UsageError } from "../workflows/check.ts"

/** Usage text for `durable fleet`. */
export const USAGE = [
  "Usage: durable fleet setup --entry <module> --database-url <url>",
  "       durable fleet rebuild <View> --database-url <url>",
].join("\n")

/** Parsed arguments of `fleet setup|rebuild`. */
export type FleetOptions =
  | { readonly command: "setup"; readonly entry: string; readonly databaseUrl: string }
  | { readonly command: "rebuild"; readonly view: string; readonly databaseUrl: string }

/** Parses the arguments after `fleet`: the command, a view name for `rebuild`, then flags. */
export const parseFleet = ([command, ...rest]: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (command !== "setup" && command !== "rebuild")
      return yield* UsageError.make({ message: `Unknown fleet command: ${command ?? ""}` })

    const [view, args] =
      command === "rebuild" && rest[0] !== undefined && !rest[0].startsWith("--")
        ? [rest[0], rest.slice(1)]
        : [undefined, rest]

    let entry: string | undefined
    let databaseUrl: string | undefined

    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!
      const known = arg === "--database-url" || (command === "setup" && arg === "--entry")

      if (!known) return yield* UsageError.make({ message: `Unknown argument: ${arg}` })

      const value = args[++index]

      if (value === undefined) return yield* UsageError.make({ message: `${arg} needs a value` })

      if (arg === "--entry") entry = value
      else databaseUrl = value
    }

    if (databaseUrl === undefined)
      return yield* UsageError.make({ message: "--database-url is required" })

    if (command === "rebuild")
      return view === undefined
        ? yield* UsageError.make({ message: "fleet rebuild names a view" })
        : ({ command, view, databaseUrl } satisfies FleetOptions)

    if (entry === undefined) return yield* UsageError.make({ message: "--entry is required" })

    return { command, entry, databaseUrl } satisfies FleetOptions
  })

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
