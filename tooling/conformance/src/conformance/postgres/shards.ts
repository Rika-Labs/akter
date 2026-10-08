import { type ConformanceGroup, conformanceGroups } from "../../conformance.ts"

/**
 * The conformance groups that run in a Vitest project of their own, keyed by
 * the project's name. Each project runs `backend.test.ts` in its own worker
 * against its own database; every group no shard names runs in the
 * `conformance` project, so a new group is never left without a worker.
 * Every group with a case that requires the streaming replica runs in the
 * `replica` shard: those cases pause WAL replay, which is server-wide, so no
 * other worker may pause or read the replica beside them.
 */
export const shards = {
  adoption: ["adoption"],
  capacity: ["capacity"],
  connections: ["connections"],
  "cold-serve": ["coldServe"],
  cron: ["cron", "cronCluster"],
  drain: ["drain"],
  "effect-control": ["effectControl", "effectControlCluster"],
  fleet: ["fleet"],
  heap: ["heap"],
  "multi-runner": ["multiRunner"],
  offline: ["offline"],
  "payload-migrations": ["payloadMigrations"],
  progress: ["progress", "progressDelivery"],
  properties: ["properties"],
  relay: ["relay", "relayCluster"],
  replica: ["readYourWrites", "rls", "watch"],
  simulation: ["simulation"],
  "single-shard": ["singleShard"],
  singleton: ["singleton"],
  streams: ["streams"],
  subscriptions: ["subscriptions", "subscriptionsRetention", "subscriptionsCluster"],
  transports: ["transports"],
  "workflow-versions": ["workflowVersions"],
  workflows: ["workflows"],
} as const satisfies Record<string, ReadonlyArray<ConformanceGroup>>

/** The project that runs every group no shard names. */
export const UNSHARDED = "conformance"

const sharded = new Set<ConformanceGroup>(Object.values(shards).flat())

/** Every group no `shards` entry names, in registration order. */
export const unshardedGroups = (Object.keys(conformanceGroups) as Array<ConformanceGroup>).filter(
  (group) => !sharded.has(group),
)

/**
 * The groups one integration project runs: a `shards` entry, `UNSHARDED`,
 * or every group when no project names one, as in an ad-hoc run of the file.
 */
export const groupsOf = (shard: string | undefined): ReadonlyArray<ConformanceGroup> => {
  if (shard === undefined) return Object.keys(conformanceGroups) as Array<ConformanceGroup>

  if (shard === UNSHARDED) return unshardedGroups

  if (!Object.hasOwn(shards, shard)) throw new Error(`Unknown conformance shard ${shard}`)

  return shards[shard as keyof typeof shards]
}
