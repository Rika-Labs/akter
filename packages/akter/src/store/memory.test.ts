import { Effect } from "effect"
import { storeConformance } from "../../../../tooling/conformance/src/conformance/store.ts"
import { memoryBucket } from "./memory.ts"

storeConformance({
  name: "memory",
  namespace: Effect.sync(() => {
    const bucket = memoryBucket()
    return Effect.succeed(bucket)
  }),
})
