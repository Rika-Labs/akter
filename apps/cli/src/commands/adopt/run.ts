import {
  adoptionStatus,
  adoptionWriters,
  backfillAdoption,
  enforceAdoption,
  formatAdoptionPlan,
  formatAdoptionStatus,
  formatBackfill,
  formatEnforce,
  formatObservedWriter,
  observeAdoption,
  planAdoption,
  releaseAdoption,
  type AdoptionRefused,
} from "@rikalabs/akter/runtime"
import { Clock, Console, Effect, Layer, Option, type Redacted } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { Database } from "@rikalabs/akter/runtime"
import { CommandFailed, fail } from "../../failure.ts"
import { PlatformCrypto } from "../../platform.ts"
import { actorsOf, entryFlags, loadEntry } from "../workflows/check.ts"

/** The commands `akter adopt` runs. */
export type AdoptCommand = "plan" | "observe" | "backfill" | "enforce" | "status" | "release"

/** What one `adopt` command runs with. */
export interface AdoptOptions {
  readonly command: AdoptCommand
  readonly entry: string | undefined
  readonly databaseUrl: Redacted.Redacted
  readonly table: string | undefined
  readonly json: boolean
  readonly report: boolean
  readonly clear: boolean
  readonly sinceMs: number | undefined
  readonly batch: number | undefined
  readonly writerRole: string | undefined
  readonly allow: ReadonlyArray<string>
  readonly quietMs: number | undefined
}

const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const

const WINDOW = /^([1-9][0-9]*)([mhd])$/

/** A window such as `30m`, `12h`, or `7d`, in milliseconds. */
export const parseWindow = (text: string) => {
  const match = WINDOW.exec(text)

  return match === null
    ? Option.none()
    : Option.some(Number(match[1]) * UNITS[match[2] as keyof typeof UNITS])
}

const printJson = <A>(value: A) => JSON.stringify(value, null, 2)

/**
 * Runs one `adopt` command against the entry's actors and returns what it
 * prints. `plan` exits 1 while any table has a problem; a refused command
 * prints why and exits 1.
 */
export const adopt = ({
  options,
  actors,
}: {
  readonly options: AdoptOptions
  readonly actors: ReadonlyArray<object>
}) =>
  Effect.gen(function* () {
    if (options.command === "status") {
      const statuses = yield* adoptionStatus

      return {
        output: options.json
          ? printJson({ tables: statuses })
          : statuses.length === 0
            ? "No table is adopted"
            : statuses.map(formatAdoptionStatus).join("\n"),
        exitCode: 0,
      }
    }

    if (options.command === "enforce") {
      const enforced = yield* enforceAdoption(actors, {
        only: options.table!,
        writerRole: options.writerRole!,
        allowedRoles: options.allow,
        quietMs: options.quietMs,
        nowMs: yield* Clock.currentTimeMillis,
      })

      return {
        output: options.json ? printJson({ enforced }) : enforced.map(formatEnforce).join("\n"),
        exitCode: 0,
      }
    }

    if (options.command === "release") {
      const released = yield* releaseAdoption(actors, { only: options.table! })

      return {
        output: options.json
          ? printJson({ observing: released })
          : released.map((table) => `${table} is observing again`).join("\n"),
        exitCode: 0,
      }
    }

    if (options.command === "plan") {
      const plans = yield* planAdoption(actors, options.table)

      return {
        output: options.json
          ? printJson({ tables: plans })
          : plans.map(formatAdoptionPlan).join("\n\n"),
        exitCode: plans.some((plan) => plan.problems.length > 0) ? 1 : 0,
      }
    }

    if (options.command === "backfill") {
      const results = yield* backfillAdoption(actors, {
        only: options.table,
        batch: options.batch,
      })

      return {
        output: options.json
          ? printJson({ tables: results })
          : results.map(formatBackfill).join("\n"),
        exitCode: 0,
      }
    }

    if (options.report) {
      const writers = yield* adoptionWriters(actors, {
        only: options.table,
        sinceMs: options.sinceMs,
        clear: options.clear,
      })

      return {
        output: options.json
          ? printJson({ writers })
          : writers.length === 0
            ? "No write was recorded"
            : writers.map(formatObservedWriter).join("\n"),
        exitCode: 0,
      }
    }

    const observed = yield* observeAdoption(actors, options.table)

    return {
      output: options.json
        ? printJson({ observing: observed })
        : observed.map((table) => `${table} is observing`).join("\n"),
      exitCode: 0,
    }
  }).pipe(
    Effect.catchTag("AdoptionRefused", (refused: AdoptionRefused) =>
      Effect.succeed({ output: refused.message, exitCode: 1 }),
    ),
  )

/**
 * Loads the entry's actors when it names one, runs `adopt` against its
 * Postgres, and prints the result; a refusal or a plan with problems exits 1.
 */
const run = (options: AdoptOptions) =>
  Effect.gen(function* () {
    const actors =
      options.entry === undefined
        ? []
        : yield* actorsOf({ module: yield* loadEntry(options.entry), entry: options.entry })

    const services = yield* Layer.build(
      Database.postgres({ url: options.databaseUrl }).pipe(
        Layer.provideMerge(PlatformCrypto.layer),
      ),
    )

    const { output, exitCode } = yield* adopt({ options, actors }).pipe(
      Effect.provideContext(services),
    )

    yield* Console.log(output)

    if (exitCode !== 0) return yield* CommandFailed.make({ exitCode, reason: "Refused" })
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      SqlError: (error) =>
        fail({
          reason: error._tag,
          message: `Cannot read adoption state (is the database migrated to 0024_adoption?): ${error.message}`,
        }),
      UsageError: (error) => fail({ reason: error._tag, message: error.message }),
    }),
  )

const defaults = {
  entry: undefined,
  table: undefined,
  report: false,
  clear: false,
  sinceMs: undefined,
  batch: undefined,
  writerRole: undefined,
  allow: [],
  quietMs: undefined,
} as const

const table = (verb: string) =>
  Argument.String("table").pipe(Argument.withDescription(`The adopted table to ${verb}`))

/** `akter adopt plan`: each adopted table's plan and the SQL it needs; exits 1 while a table has a problem. */
export const planCommand = Command.make(
  "plan",
  {
    ...entryFlags,
    table: Flag.String("table").pipe(
      Flag.optional,
      Flag.withDescription("Plan only this adopted table"),
    ),
  },
  (options) =>
    run({
      ...defaults,
      ...options,
      command: "plan",
      table: Option.getOrUndefined(options.table),
    }),
).pipe(
  Command.withDescription(
    "Plan adopting the entry's existing tables, with the SQL each needs; exit 1 while a table has a problem",
  ),
)

/** `akter adopt observe <table>`: starts recording legacy writes, or reports them with `--report`. */
export const observeCommand = Command.make(
  "observe",
  {
    ...entryFlags,
    table: table("observe"),
    report: Flag.Boolean("report").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Report the writes recorded so far instead of starting to observe"),
    ),
    since: Flag.String("since").pipe(
      Flag.filterMap(parseWindow, () => "a window such as 30m, 12h, or 7d"),
      Flag.optional,
      Flag.withDescription("With --report, only writes within this window, such as 7d"),
    ),
    clear: Flag.Boolean("clear").pipe(
      Flag.withDefault(false),
      Flag.withDescription("With --report, clear the reported writes"),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      if ((Option.isSome(options.since) || options.clear) && !options.report)
        return yield* fail({
          reason: "UsageError",
          message: "--since and --clear belong to observe --report",
        })

      const nowMs = yield* Clock.currentTimeMillis

      return yield* run({
        ...defaults,
        ...options,
        command: "observe",
        sinceMs: Option.getOrUndefined(Option.map(options.since, (window) => nowMs - window)),
      })
    }),
).pipe(
  Command.withDescription(
    "Record which writers still write an adopted table, or report them with --report",
  ),
)

/** `akter adopt backfill <table>`: fills `routing_key` on an observed table in batches. */
export const backfillCommand = Command.make(
  "backfill",
  {
    ...entryFlags,
    table: table("backfill"),
    batch: Flag.Int("batch").pipe(
      Flag.filter(
        (batch) => batch >= 1,
        () => "a positive integer",
      ),
      Flag.optional,
      Flag.withDescription("Rows per pass (default 1000)"),
    ),
  },
  (options) =>
    run({
      ...defaults,
      ...options,
      command: "backfill",
      batch: Option.getOrUndefined(options.batch),
    }),
).pipe(Command.withDescription("Fill routing_key on an observed table's rows, in batches"))

/** `akter adopt enforce <table>`: makes a backfilled table the runtime's, refusing other writers. */
export const enforceCommand = Command.make(
  "enforce",
  {
    ...entryFlags,
    table: table("enforce"),
    writerRole: Flag.String("writer-role").pipe(
      Flag.withDescription("The database role the runtime writes the table as"),
    ),
    allow: Flag.String("allow").pipe(
      Flag.atLeast(0),
      Flag.withDescription("Another role still allowed to write the table; repeat for several"),
    ),
    quiet: Flag.String("quiet").pipe(
      Flag.filterMap(parseWindow, () => "a window such as 30m, 12h, or 7d"),
      Flag.optional,
      Flag.withDescription(
        "How long no legacy write may have been recorded before enforcing, such as 7d",
      ),
    ),
  },
  (options) =>
    run({
      ...defaults,
      ...options,
      command: "enforce",
      quietMs: Option.getOrUndefined(options.quiet),
    }),
).pipe(
  Command.withDescription(
    "Enforce an adopted table: only the runtime's writer role and --allow roles may write it",
  ),
)

/** `akter adopt release <table> --to observe`: returns an enforced table to observing. */
export const releaseCommand = Command.make(
  "release",
  {
    ...entryFlags,
    table: table("release"),
    to: Flag.Literals("to", ["observe"]).pipe(
      Flag.withDescription("The mode to return the table to; only observe"),
    ),
  },
  (options) => run({ ...defaults, ...options, command: "release" }),
).pipe(Command.withDescription("Return an enforced table to observing"))

/** `akter adopt status`: every adopted table's mode and rows left to backfill. */
export const statusCommand = Command.make(
  "status",
  { databaseUrl: entryFlags.databaseUrl, json: entryFlags.json },
  (options) => run({ ...defaults, ...options, command: "status" }),
).pipe(Command.withDescription("Show each adopted table's mode and the rows left to backfill"))
