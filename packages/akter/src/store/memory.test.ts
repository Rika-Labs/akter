import { Effect } from "effect"
import { storeConformance } from "../../../../tooling/conformance/src/conformance/store.ts"
import { memoryBucket } from "./memory.ts"
import { operatorConformance } from "../../../../tooling/conformance/src/conformance/operators.ts"
import { retentionConformance } from "../../../../tooling/conformance/src/conformance/retention.ts"

storeConformance({
  name: "memory",
  namespace: Effect.sync(() => {
    const bucket = memoryBucket()
    return Effect.succeed(bucket)
  }),
})

operatorConformance({
  name: "memory",
  location: Effect.sync(() => {
    const bucket = memoryBucket()
    return { bucket: Effect.succeed(bucket), env: {} }
  }),
})

retentionConformance({
  name: "memory",
  namespace: Effect.sync(() => Effect.succeed(memoryBucket())),
})
