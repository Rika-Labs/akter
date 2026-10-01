import type { ConformanceCase } from "../conformance.ts"
import { connectionHolderConformance } from "./connections/holders.ts"
import { connectionLifecycleConformance } from "./connections/lifecycle.ts"
import { connectionLimitConformance } from "./connections/limits.ts"
import { connectionReauthorizationConformance } from "./connections/reauthorization.ts"
import { connectionResyncConformance } from "./connections/resync.ts"
import { connectionTakeoverConformance } from "./connections/takeover.ts"
import type { ConnectionsFixture } from "./connections/actors.ts"

/** Connection cases: open, ordered frames, session storage, broadcasts, and cleanup on close. */
export const connectionsConformance: ReadonlyArray<ConformanceCase<ConnectionsFixture>> = [
  ...connectionLifecycleConformance,
  ...connectionReauthorizationConformance,
  ...connectionResyncConformance,
  ...connectionLimitConformance,
  ...connectionHolderConformance,
  ...connectionTakeoverConformance,
]
