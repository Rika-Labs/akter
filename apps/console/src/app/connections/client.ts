import { Effect } from "effect"
import { connections } from "./fixtures.ts"
import type { ConnectionsPage } from "./model.ts"

/** Loads live connection counts. Fixture-backed until the connections API is hosted. */
export const loadConnections: Effect.Effect<ConnectionsPage> = Effect.succeed(connections)
