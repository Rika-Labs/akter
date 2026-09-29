import { checkPayloads, clearPayloads, formatPayloadProblem } from "@durable-actors/core/runtime"
import type { ClearResult, PayloadProblem } from "@durable-actors/core/runtime"
import { Effect } from "effect"
import { UsageError } from "../workflows/check.ts"

export const USAGE =
  "Usage: durable payloads check|clear --entry <module> --database-url <url> [--json]"

export interface PayloadsOptions {
  readonly command: "check" | "clear"
  readonly entry: string
  readonly databaseUrl: string
  readonly json: boolean
}

/** Parses the arguments after `payloads`. */
export const parsePayloads = (command: string | undefined, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (command !== "check" && command !== "clear")
      return yield* UsageError.make({ message: `Unknown payloads command: ${command ?? ""}` })

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

    return { command, entry, databaseUrl, json } satisfies PayloadsOptions
  })

/** What `payloads check` prints: exit 1 when a deployment of `actors` would be refused. */
export const checkReport = ({
  problems,
  json,
}: {
  readonly problems: ReadonlyArray<PayloadProblem>
  readonly json: boolean
}) => ({
  output: json
    ? JSON.stringify({ compatible: problems.length === 0, problems }, null, 2)
    : problems.length === 0
      ? "Every stored event and effect payload version decodes"
      : [
          ...problems.map(formatPayloadProblem),
          `${problems.length} problem${problems.length === 1 ? "" : "s"}; deploy refused (exit 1)`,
        ].join("\n"),
  exitCode: problems.length === 0 ? 0 : 1,
})

const reasons = {
  cleared: "cleared",
  writer: "not cleared: a runtime wrote it within its writer window and command timeout",
  stored: "not cleared: events of this version are still stored",
} as const

/** What `payloads clear` prints: exit 1 when a superseded version stays uncleared. */
export const clearReport = ({
  results,
  json,
}: {
  readonly results: ReadonlyArray<ClearResult>
  readonly json: boolean
}) => ({
  output: json
    ? JSON.stringify({ results }, null, 2)
    : results.length === 0
      ? "No superseded event version is past its retention horizon"
      : results
          .map(
            (result) =>
              `${result.actorType}/${result.tag}  version ${result.version}  ${reasons[result.outcome]}`,
          )
          .join("\n"),
  exitCode: results.every((result) => result.outcome === "cleared") ? 0 : 1,
})

/** Runs `payloads check` read-only, or `payloads clear`, against the entry's actors. */
export const payloads = ({
  command,
  actors,
  json,
}: {
  readonly command: "check" | "clear"
  readonly actors: ReadonlyArray<object>
  readonly json: boolean
}) =>
  command === "check"
    ? checkPayloads(actors).pipe(Effect.map((problems) => checkReport({ problems, json })))
    : clearPayloads(actors).pipe(Effect.map((results) => clearReport({ results, json })))
