import type { ConformanceGroup } from "../../conformance.ts"

/**
 * The conformance groups the Neki suite runs. Each one runs against a router
 * the suite cannot create databases on, so a group whose cases open a
 * `freshDatabase` or a `snapshot` is not here; `backend.test.ts` reports its
 * cases as skipped by name. `groups.test.ts` reads every module to keep both
 * lists true.
 */
export const nekiGroups = [
  "foundation",
  "admission",
  "http",
  "assertions",
  "edge",
  "client",
  "events",
  "reducer",
  "outbox",
  "tables",
  "effects",
  "blobs",
  "batches",
  "inspectionViews",
  "inspector",
  "mint",
  "readYourWrites",
  "placement",
  "singleShard",
  "properties",
] as const satisfies ReadonlyArray<ConformanceGroup>
