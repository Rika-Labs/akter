import { Effect } from "effect"
import { regions } from "./fixtures.ts"
import type { RegionsPage } from "./model.ts"

/** Loads regions and their databases. Fixture-backed until the infrastructure API is hosted. */
export const loadRegions: Effect.Effect<RegionsPage> = Effect.succeed(regions)
