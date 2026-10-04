import { DateTime, Effect } from "effect"
import { type ConsoleError, type Loaded, load, withProject } from "../api/client.ts"
import { toWorkflowsPage } from "./mapping.ts"
import type { WorkflowsPage } from "./model.ts"

const fixtureSchedules = Effect.promise(() =>
  import("./fixtures.ts").then((fixtures) => fixtures.workflows.schedules),
)

/**
 * Loads the newest workflows, the pending timers and the schedules. Schedules the API cannot list
 * yet fall back to sample rows on their own, so the workflows and timers stay live.
 */
export const loadWorkflows: Effect.Effect<Loaded<WorkflowsPage>, ConsoleError> = withProject(
  (api, { project, environment }) =>
    Effect.gen(function* () {
      const params = { projectId: project.id, environment }
      const [workflows, timers, schedules] = yield* Effect.all(
        [
          api.runtime.listWorkflows({ params, query: { limit: 100 } }),
          api.runtime.getTimers({ params }),
          load(api.runtime.listSchedules({ params }), () => Promise.resolve([])),
        ],
        { concurrency: "unbounded" },
      )
      return toWorkflowsPage(yield* DateTime.now)({
        workflows: workflows.items,
        truncated: workflows.nextCursor !== null,
        timers,
        schedules: schedules.data,
        sampleSchedules: schedules.sample ? yield* fixtureSchedules : undefined,
      })
    }),
  () => import("./fixtures.ts").then((fixtures) => fixtures.workflows),
)
