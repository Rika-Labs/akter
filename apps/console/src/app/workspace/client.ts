import { Effect } from "effect"
import { workspace } from "./fixtures.ts"
import type { Workspace } from "./model.ts"

/**
 * Loads the signed-in workspace. Served from fixtures today; the hosted API's workspace endpoint
 * replaces this body without changing its type.
 */
export const loadWorkspace: Effect.Effect<Workspace> = Effect.succeed(workspace)
