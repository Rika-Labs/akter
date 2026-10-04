import { DeadLetterId } from "@akter/cloud-api"
import { DateTime, Effect, Schema } from "effect"
import {
  cloud,
  ConsoleError,
  consoleError,
  fixturesEnabled,
  type Loaded,
  projectContext,
  withProject,
} from "../api/client.ts"
import { toJobsPage } from "./mapping.ts"
import type { JobsPage } from "./model.ts"

/**
 * Loads the queue totals and the first page of dead letters. The API reads dead letters but answers
 * `NotImplemented` to retry and discard, so a live page is not `resolvable` and offers neither.
 */
export const loadJobs: Effect.Effect<Loaded<JobsPage>, ConsoleError> = withProject(
  (api, { project, environment }) =>
    Effect.gen(function* () {
      const params = { projectId: project.id, environment }
      const summary = yield* api.runtime.getJobs({ params })
      const deadLetters = yield* api.runtime.listDeadLetters({ params, query: { limit: 100 } })
      return toJobsPage(yield* DateTime.now)({
        summary,
        deadLetters: deadLetters.items,
        resolvable: false,
      })
    }),
  () => import("./fixtures.ts").then((fixtures) => fixtures.jobs),
)

const resolveDeadLetter = (action: "retryDeadLetter" | "discardDeadLetter", id: string) =>
  Effect.suspend(() =>
    fixturesEnabled()
      ? Effect.fail(ConsoleError.make({ kind: "Sample", message: "Sample data can’t be changed." }))
      : Effect.gen(function* () {
          const api = yield* cloud
          const { project, environment } = yield* projectContext
          const deadLetterId = yield* Schema.decodeEffect(DeadLetterId)(id)
          yield* api.runtime[action]({
            params: { projectId: project.id, environment, deadLetterId },
          })
        }).pipe(Effect.mapError(consoleError)),
  )

/**
 * Sends a dead letter back to the queue. Fixture mode attempts nothing and fails with a `Sample`
 * `ConsoleError`, and a refusal, including an endpoint that is not implemented, fails with a
 * `ConsoleError` instead of a fake success.
 */
export const retryDeadLetter = (id: string): Effect.Effect<void, ConsoleError> =>
  resolveDeadLetter("retryDeadLetter", id)

/** Discards a dead letter for good; it fails the same ways `retryDeadLetter` does. */
export const discardDeadLetter = (id: string): Effect.Effect<void, ConsoleError> =>
  resolveDeadLetter("discardDeadLetter", id)
