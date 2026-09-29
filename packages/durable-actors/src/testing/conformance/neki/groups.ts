import type { ConformanceGroup } from "../../conformance.ts"

/**
 * The conformance groups the Neki suite leaves out: each opens a fresh
 * database or a snapshot, which the Neki backend cannot create. A group not
 * listed runs on Neki, so a new group is run there unless it needs a database
 * of its own. `backend.test.ts` reports the listed groups' cases as skipped by
 * name, and `groups.test.ts` reads every group's module to keep the list true.
 */
export const nekiExcluded = [
  "capacity",
  "heap",
  "progress",
  "multiRunner",
  "simulation",
  "drain",
  "pipeline",
  "relay",
  "relayCluster",
  "effectControl",
  "effectControlCluster",
  "singleton",
  "cron",
  "cronCluster",
  "rls",
  "retention",
  "restore",
  "workflows",
  "connections",
  "streams",
  "progressDelivery",
  "transports",
  "workflowVersions",
  "payloadMigrations",
  "subscriptions",
  "subscriptionsRetention",
  "subscriptionsCluster",
  "content",
  "counter",
  "observability",
  "operator",
] as const satisfies ReadonlyArray<ConformanceGroup>
