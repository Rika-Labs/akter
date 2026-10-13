import { Context, type Duration, type Effect } from "effect"
import type { DrainReport } from "../execution/engine.ts"

/** Readiness reflects ownership, storage, peer credentials and the runner's drain lifecycle. */
export type Readiness =
  | { readonly ready: true }
  | {
      readonly ready: false
      readonly reason: "draining" | "drained" | "storage" | "routing" | "peering" | "unregistered"
    }

/** Host-controlled graceful shutdown while the HTTP and peer listeners remain alive. */
export class RuntimeControl extends Context.Service<
  RuntimeControl,
  {
    readonly readiness: Effect.Effect<Readiness>
    readonly drain: (options: { readonly deadline: Duration.Input }) => Effect.Effect<DrainReport>
  }
>()("@rikalabs/akter/runtime/drain/RuntimeControl") {}

export type { DrainReport } from "../execution/engine.ts"
