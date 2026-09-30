import type { ConformanceCase } from "../conformance.ts"
import { workflowAccessConformance } from "./workflows/access.ts"
import { workflowBasicConformance } from "./workflows/basics.ts"
import { engineConformance } from "./workflows/engine.ts"
import { workflowGuardConformance } from "./workflows/guards.ts"
import { workflowRecoveryConformance } from "./workflows/recovery.ts"
import { workflowStartConformance } from "./workflows/starts.ts"
import { workflowSuspensionConformance } from "./workflows/suspension.ts"
import { workflowWaitConformance } from "./workflows/waits.ts"

/** Workflow cases: stable execution ids, once-recorded activities, interrupts, and recovery. */
export const workflowsConformance: ReadonlyArray<ConformanceCase> = [
  ...engineConformance,
  ...workflowBasicConformance,
  ...workflowSuspensionConformance,
  ...workflowRecoveryConformance,
  ...workflowStartConformance,
  ...workflowAccessConformance,
  ...workflowGuardConformance,
  ...workflowWaitConformance,
]
