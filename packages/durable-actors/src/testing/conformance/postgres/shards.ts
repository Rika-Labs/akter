import type { ConformanceGroup } from "../../conformance.ts"

/**
 * The conformance groups that run in a Vitest file of their own, keyed by that
 * file's name beside `conformance/`. A group named here runs in its own worker
 * against its own database; every other group runs in `conformance.test.ts`, so
 * a new group is never left without a file. The replica cases (`readYourWrites`
 * and the replica case of `rls`) stay in that catch-all file: they pause WAL
 * replay, which is server-wide, so no other worker may run beside them on the
 * replica.
 */
export const shards = {
  capacity: ["capacity"],
  connections: ["connections"],
  cron: ["cron", "cronCluster"],
  drain: ["drain"],
  "effect-control": ["effectControl", "effectControlCluster"],
  heap: ["heap"],
  "multi-runner": ["multiRunner"],
  "payload-migrations": ["payloadMigrations"],
  progress: ["progress", "progressDelivery"],
  properties: ["properties"],
  relay: ["relay", "relayCluster"],
  "single-shard": ["singleShard"],
  singleton: ["singleton"],
  streams: ["streams"],
  subscriptions: ["subscriptions", "subscriptionsRetention", "subscriptionsCluster"],
  transports: ["transports"],
  "workflow-versions": ["workflowVersions"],
  workflows: ["workflows"],
} as const satisfies Record<string, ReadonlyArray<ConformanceGroup>>
