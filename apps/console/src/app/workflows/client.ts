import { Effect } from "effect"
import { workflows } from "./fixtures.ts"
import type { WorkflowsPage } from "./model.ts"

/** Loads workflows and schedules. Fixture-backed until the workflow API is hosted. */
export const loadWorkflows: Effect.Effect<WorkflowsPage> = Effect.succeed(workflows)
