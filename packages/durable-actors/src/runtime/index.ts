import { layer } from "./layer.ts"
import { serve } from "../serve/layer.ts"
import { make, none } from "../serve/auth.ts"
import { jwt } from "../serve/jwt.ts"
import { assertion } from "../serve/assertion/verify.ts"

/** Runtime construction: actor execution and authenticated protocol routes. */
export const Actors = { layer, serve }

/** Authentication providers for one served runtime. `none` is an explicit public opt-out. */
export const Auth = { none, make, jwt, assertion }

export type { ServeOptions } from "../serve/layer.ts"

export type { AuthProvider, AuthRequest, Authenticated, Binding } from "../serve/auth.ts"

export {
  ASSERTION_SKEW_MS,
  AssertionClaims,
  AssertionKey,
  AssertionKeySet,
  KeyRefreshClaims,
  MAX_ASSERTION_SECONDS,
} from "../serve/assertion/verify.ts"

export type { AssertionOptions } from "../serve/assertion/verify.ts"

export { actorErrorBody, closeCodeOf, statusOf } from "../protocol/wire.ts"

export { Database } from "./layer.ts"

export { DataDirLocked, DataDirVersion } from "../errors/database.ts"

export type { Options } from "./layer.ts"

export { RuntimeControl } from "./drain.ts"

export type { DrainReport, Readiness } from "./drain.ts"

export { checkWorkflows, formatIncompatibility } from "./workflows/compatibility.ts"

export type { Incompatibility } from "./workflows/compatibility.ts"

export { Inspector } from "./inspector/layer.ts"

export type { InspectorOptions } from "./inspector/layer.ts"

export { Telemetry } from "./telemetry/routes.ts"

export type { TelemetryOptions } from "./telemetry/routes.ts"

export { DefectLog, DefectRecord, DefectRecords } from "./telemetry/defects.ts"

export { TelemetrySampler } from "./telemetry/sampler.ts"

export { Metrics } from "./telemetry/metrics.ts"

export { SpanNames } from "./telemetry/spans.ts"

export { Operators } from "./operators/routes.ts"

export type { OperatorsOptions } from "./operators/routes.ts"

export { OperatorAuth } from "./operators/auth.ts"

export { Capability, OperatorAction, OperatorGrant } from "./operators/grants.ts"

export { AuditRecord } from "./operators/audit.ts"

export { Seed, SeedJson } from "./operators/seed.ts"

export { checkPayloads, clearPayloads, formatPayloadProblem } from "./payloads/versions.ts"

export type { ClearResult, PayloadProblem } from "./payloads/versions.ts"

export { AdoptionRefused } from "./adoption/target.ts"

export { formatAdoptionPlan, planAdoption } from "./adoption/plan.ts"

export type { AdoptionPlan } from "./adoption/plan.ts"

export { adoptionWriters, formatObservedWriter, observeAdoption } from "./adoption/observe.ts"

export type { ObservedWriter } from "./adoption/observe.ts"

export { backfillAdoption, formatBackfill } from "./adoption/backfill.ts"

export type { BackfillResult } from "./adoption/backfill.ts"

export { adoptionStatus, formatAdoptionStatus } from "./adoption/status.ts"

export type { AdoptionStatus } from "./adoption/status.ts"

export { enforceAdoption, formatEnforce, releaseAdoption } from "./adoption/enforce.ts"

export type { EnforceResult } from "./adoption/enforce.ts"

export { FleetSetupRefused, rebuildFleetView, setupFleet } from "./fleet/setup.ts"

export type { FleetSetup } from "./fleet/setup.ts"
