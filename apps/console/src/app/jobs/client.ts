import { Effect } from "effect"
import { jobs } from "./fixtures.ts"
import type { JobsPage } from "./model.ts"

/** Loads the jobs page. Fixture-backed until the jobs API is hosted. */
export const loadJobs: Effect.Effect<JobsPage> = Effect.succeed(jobs)
