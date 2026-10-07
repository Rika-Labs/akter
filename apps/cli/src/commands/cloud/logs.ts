import {
  DeploymentId,
  EnvironmentName,
  LogLimit,
  MAX_LOG_WAIT_SECONDS,
  MAX_LOG_WINDOW_SECONDS,
  ProjectId,
  type RunnerLogPage,
  type Unavailable,
} from "@akter/cloud-api"
import { Config, Console, DateTime, Effect, Option, Schema } from "effect"
import type { HttpClientError } from "effect/http"
import { Command, Flag } from "effect/cli"

import { reportFailures, signedIn } from "./client.ts"

const colourSequence = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-?]*[ -/]*[@-~]`, "gu")

/** Bounded long polls resume after transport failures without retrying authentication refusals. */
export const logsCommand = Command.make(
  "logs",
  {
    project: Flag.String("project").pipe(
      Flag.withFallbackConfig(Config.String("AKTER_PROJECT")),
      Flag.withSchema(ProjectId),
      Flag.withDescription("The project (default AKTER_PROJECT)"),
    ),
    environment: Flag.Literals("env", EnvironmentName.literals).pipe(
      Flag.withDefault("production"),
      Flag.withDescription("The environment (default production)"),
    ),
    deployment: Flag.String("deployment").pipe(
      Flag.withSchema(DeploymentId),
      Flag.optional,
      Flag.withDescription("Read a deployment instead of the environment's current deployment"),
    ),
    since: Flag.Int("since").pipe(
      Flag.withSchema(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LOG_WINDOW_SECONDS })),
      ),
      Flag.withDefault(300),
      Flag.withDescription("Seconds of recent output, 1–3600 (default 300)"),
    ),
    limit: Flag.Int("limit").pipe(
      Flag.withSchema(LogLimit),
      Flag.withDefault(100),
      Flag.withDescription("Maximum lines per response, 1–200 (default 100)"),
    ),
    follow: Flag.Boolean("follow").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Resume long polls until interrupted"),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const { client } = yield* signedIn
      const since = DateTime.subtract(yield* DateTime.now, { seconds: options.since })
      let cursor: string | undefined
      let more = false
      let failures = 0
      const retryRead = (error: HttpClientError.HttpClientError | Unavailable) =>
        Effect.gen(function* () {
          if (!options.follow || failures >= 5) return yield* error
          failures += 1
          yield* Console.error("Log read unavailable; reconnecting from the last cursor.")
          yield* Effect.sleep(`${Math.min(2 ** (failures - 1), 8)} seconds`)
          return undefined
        })
      while (true) {
        const query: Parameters<typeof client.deployments.getLogs>[0]["query"] = {
          since,
          limit: options.limit,
          cursor,
          wait: options.follow && cursor !== undefined && !more ? MAX_LOG_WAIT_SECONDS : 0,
        }
        const request = Option.isSome(options.deployment)
          ? client.deployments.getLogs({
              params: { projectId: options.project, deploymentId: options.deployment.value },
              query,
            })
          : client.deployments.getEnvironmentLogs({
              params: { projectId: options.project, environment: options.environment },
              query,
            })
        const page: RunnerLogPage | undefined = yield* request.pipe(
          Effect.catchTags({ HttpClientError: retryRead, Unavailable: retryRead }),
        )
        if (page === undefined) continue
        failures = 0
        for (const line of page.lines)
          yield* Console.log(
            `${DateTime.formatIso(line.at)}\t${line.runnerId}\t${line.stream}\t${line.text.replace(colourSequence, "").replace(/\p{Cc}|[\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, "�")}${line.clipped ? " …" : ""}`,
          )
        cursor = page.cursor
        more = page.more
        if (!options.follow && !more) return
        if (page.lines.length === 0 && !more) yield* Effect.sleep("1 second")
      }
    }).pipe(reportFailures),
).pipe(
  Command.withDescription("Read recent customer runner logs, or follow with resumable long polls"),
)
