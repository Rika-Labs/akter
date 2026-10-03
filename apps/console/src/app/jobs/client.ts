import { DeadLetterId } from "@akter/cloud-api"
import { DateTime, Effect, Schema } from "effect"
import {
  cloud,
  type ConsoleError,
  consoleError,
  fixturesEnabled,
  load,
  projectContext,
} from "../api/client.ts"
import { toJobsPage } from "./mapping.ts"
import type { JobsPage } from "./model.ts"

/** Loads the queue totals and the first page of dead letters. */
export const loadJobs: Effect.Effect<JobsPage, ConsoleError> = load(
  Effect.gen(function* () {
    const api = yield* cloud
    const { project, environment } = yield* projectContext
    const params = { projectId: project.id, environment }
    const summary = yield* api.runtime.getJobs({ params })
    const deadLetters = yield* api.runtime.listDeadLetters({ params, query: { limit: 100 } })
    return toJobsPage(yield* DateTime.now)({ summary, deadLetters: deadLetters.items })
  }),
  () => import("./fixtures.ts").then((fixtures) => fixtures.jobs),
)

const resolveDeadLetter = (action: "retryDeadLetter" | "discardDeadLetter", id: string) =>
  Effect.suspend(() =>
    fixturesEnabled()
      ? Effect.void
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
 * Sends a dead letter back to the queue. Fixture mode attempts nothing, and a refusal, including
 * an endpoint that is not implemented, fails with a `ConsoleError` instead of a fake success.
 */
export const retryDeadLetter = (id: string): Effect.Effect<void, ConsoleError> =>
  resolveDeadLetter("retryDeadLetter", id)

/** Discards a dead letter for good; it fails the same ways `retryDeadLetter` does. */
export const discardDeadLetter = (id: string): Effect.Effect<void, ConsoleError> =>
  resolveDeadLetter("discardDeadLetter", id)
