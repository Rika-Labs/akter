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
} from "@durable-actors/core/runtime"
import { Clock, Effect } from "effect"
import { UsageError } from "../workflows/check.ts"

/** Usage text for `durable adopt`. */
export const USAGE = [
  "Usage: durable adopt plan --entry <module> --database-url <url> [--table <name>] [--json]",
  "       durable adopt observe <table> --entry <module> --database-url <url>",
  "       durable adopt observe <table> --report [--since 7d] [--clear] --entry <module> --database-url <url> [--json]",
  "       durable adopt backfill <table> [--batch 1000] --entry <module> --database-url <url>",
  "       durable adopt enforce <table> --writer-role <role> [--allow <role>]... [--quiet 7d] --entry <module> --database-url <url>",
  "       durable adopt status --database-url <url> [--json]",
  "       durable adopt release <table> --to observe --entry <module> --database-url <url>",
].join("\n")

/** The commands `durable adopt` runs. */
export type AdoptCommand = "plan" | "observe" | "backfill" | "enforce" | "status" | "release"

/** Parsed arguments of `adopt`. */
export interface AdoptOptions {
  readonly command: AdoptCommand
  readonly entry: string | undefined
  readonly databaseUrl: string
  readonly table: string | undefined
  readonly json: boolean
  readonly report: boolean
  readonly clear: boolean
  readonly sinceMs: number | undefined
  readonly batch: number | undefined
  readonly writerRole: string | undefined
  readonly allow: ReadonlyArray<string>
  readonly quietMs: number | undefined
  readonly to: string | undefined
}

const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const

const WINDOW = /^([1-9][0-9]*)([mhd])$/

/** A window such as `30m`, `12h`, or `7d`, in milliseconds. */
export const parseWindow = ({ flag, text }: { readonly flag: string; readonly text: string }) => {
  const match = WINDOW.exec(text)

  if (match === null)
    return Effect.fail(
      UsageError.make({ message: `${flag} takes a window such as 30m, 12h, or 7d` }),
    )

  return Effect.succeed(Number(match[1]) * UNITS[match[2] as keyof typeof UNITS])
}

/** Parses the arguments after `adopt`: the command, an optional table, then its flags. */
export const parseAdopt = ({
  args: [command, ...args],
  nowMs,
}: {
  readonly args: ReadonlyArray<string>
  readonly nowMs: number
}) =>
  Effect.gen(function* () {
    if (
      command !== "plan" &&
      command !== "observe" &&
      command !== "backfill" &&
      command !== "enforce" &&
      command !== "status" &&
      command !== "release"
    )
      return yield* UsageError.make({ message: `Unknown adopt command: ${command ?? ""}` })

    let entry: string | undefined
    let databaseUrl: string | undefined
    let table: string | undefined
    let json = false
    let report = false
    let clear = false
    let sinceMs: number | undefined
    let batch: number | undefined
    let writerRole: string | undefined
    let quietMs: number | undefined
    let to: string | undefined
    const allow: Array<string> = []

    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!

      if (arg === "--json") json = true
      else if (arg === "--report") report = true
      else if (arg === "--clear") clear = true
      else if (
        arg === "--entry" ||
        arg === "--database-url" ||
        arg === "--table" ||
        arg === "--since" ||
        arg === "--batch" ||
        arg === "--writer-role" ||
        arg === "--allow" ||
        arg === "--quiet" ||
        arg === "--to"
      ) {
        const value = args[++index]

        if (value === undefined) return yield* UsageError.make({ message: `${arg} needs a value` })

        if (arg === "--entry") entry = value
        else if (arg === "--database-url") databaseUrl = value
        else if (arg === "--table") table = value
        else if (arg === "--since")
          sinceMs = nowMs - (yield* parseWindow({ flag: arg, text: value }))
        else if (arg === "--quiet") quietMs = yield* parseWindow({ flag: arg, text: value })
        else if (arg === "--writer-role") writerRole = value
        else if (arg === "--allow") allow.push(value)
        else if (arg === "--to") to = value
        else {
          batch = Number(value)

          if (!Number.isInteger(batch) || batch < 1)
            return yield* UsageError.make({ message: "--batch takes a positive integer" })
        }
      } else if (!arg.startsWith("--") && table === undefined) table = arg
      else return yield* UsageError.make({ message: `Unknown argument: ${arg}` })
    }

    if (databaseUrl === undefined)
      return yield* UsageError.make({ message: "--database-url is required" })

    if (command !== "status" && entry === undefined)
      return yield* UsageError.make({ message: "--entry is required" })

    if (command !== "plan" && command !== "status" && table === undefined)
      return yield* UsageError.make({ message: `${command} takes the table to ${command}` })

    if (command === "enforce" && writerRole === undefined)
      return yield* UsageError.make({ message: "--writer-role is required" })

    if (
      command !== "enforce" &&
      (writerRole !== undefined || allow.length > 0 || quietMs !== undefined)
    )
      return yield* UsageError.make({
        message: "--writer-role, --allow, and --quiet belong to enforce",
      })

    if (command === "release" && to !== "observe")
      return yield* UsageError.make({ message: "release takes --to observe" })

    if (command !== "release" && to !== undefined)
      return yield* UsageError.make({ message: "--to belongs to release" })

    if ((sinceMs !== undefined || clear) && !report)
      return yield* UsageError.make({ message: "--since and --clear belong to observe --report" })

    if (report && command !== "observe")
      return yield* UsageError.make({ message: "--report belongs to observe" })

    if (batch !== undefined && command !== "backfill")
      return yield* UsageError.make({ message: "--batch belongs to backfill" })

    return {
      command,
      entry,
      databaseUrl,
      table,
      json,
      report,
      clear,
      sinceMs,
      batch,
      writerRole,
      allow,
      quietMs,
      to,
    } satisfies AdoptOptions
  })

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
