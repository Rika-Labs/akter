import { DateTime, Effect } from "effect"
import { type ConsoleError, type Loaded, withProject } from "../api/client.ts"
import { toWorkflowsPage } from "./mapping.ts"
import type { WorkflowsPage } from "./model.ts"

/** Loads the newest workflows, the pending timers and the schedules. */
export const loadWorkflows: Effect.Effect<Loaded<WorkflowsPage>, ConsoleError> = withProject(
  (api, { project, environment }) =>
    Effect.gen(function* () {
      const params = { projectId: project.id, environment }
      const [workflows, timers, schedules] = yield* Effect.all(
        [
          api.runtime.listWorkflows({ params, query: { limit: 100 } }),
          api.runtime.getTimers({ params }),
          api.runtime.listSchedules({ params }),
        ],
        { concurrency: "unbounded" },
      )
      return toWorkflowsPage(yield* DateTime.now)({
        workflows: workflows.items,
        truncated: workflows.nextCursor !== null,
        timers,
        schedules,
      })
    }),
  () => import("./fixtures.ts").then((fixtures) => fixtures.workflows),
)
