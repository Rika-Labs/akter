import type { ChangePosition, ProjectionSource } from "@durable-actors/core"

/** Derived-state metadata only. No capture/relay/sink implementation. */
export interface ProjectionCheckpoint {
  readonly source: ProjectionSource
  readonly position: ChangePosition
  readonly sinkGeneration: string
}
export interface ProjectionLag {
  readonly status: "unknown" | "catching-up" | "caught-up" | "blocked"
  readonly oldestPendingAt: string | null
}
