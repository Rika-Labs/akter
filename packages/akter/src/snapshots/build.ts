import { Schema } from "effect"
import { Build } from "../store/build.ts"

/** The framework version an embedding records as the application's `framework` when it has no other. */
export const frameworkVersion = "0.2.0-dev"

/**
 * Whether a segment's build may be replayed by the running one: every field must match, since a
 * changed handler, schema, runtime, engine or locale database can change what an action computes.
 */
const same: (left: Build, right: Build) => boolean = Schema.toEquivalence(Build)

/** Build identity: whether this process may replay what another build wrote. */
export const Builds = { same }
