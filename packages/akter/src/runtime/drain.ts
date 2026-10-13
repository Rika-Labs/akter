import { Console, Context, Effect, Schema } from "effect"
import type { Duration } from "effect"
import type { UsageSnapshot } from "./telemetry/usage.ts"

/** The shutdown and scale-to-zero handoff a host reads after the runner stops admission. */
export const DrainReport = Schema.Struct({
  outcome: Schema.Literals(["clean", "timedOut"]),
  actions: Schema.optionalKey(Schema.Natural),
  jobSeconds: Schema.optionalKey(Schema.Natural),
  shards: Schema.Array(
    Schema.Struct({
      shard: Schema.Int,
      offset: Schema.Finite,
      nextDue: Schema.NullOr(Schema.Finite),
    }),
  ),
})

export type DrainReport = typeof DrainReport.Type

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
    readonly usage: Effect.Effect<UsageSnapshot>
    readonly drain: (options: { readonly deadline: Duration.Input }) => Effect.Effect<DrainReport>
  }
>()("@rikalabs/akter/runtime/drain/RuntimeControl") {
  /** Waits for SIGTERM or SIGINT without interrupting the runtime, drains it, and prints its durable wake report. */
  static waitForSignal = (options: { readonly deadline: Duration.Input }) =>
    Effect.gen(function* () {
      const control = yield* RuntimeControl
      yield* Effect.callback<void>((resume) => {
        const stop = () => resume(Effect.void)
        process.once("SIGTERM", stop)
        process.once("SIGINT", stop)
        return Effect.sync(() => {
          process.removeListener("SIGTERM", stop)
          process.removeListener("SIGINT", stop)
        })
      })
      const report = yield* control.drain(options)
      const json = yield* Schema.encodeEffect(Schema.fromJsonString(DrainReport))(report)
      yield* Console.log(`DRAINED ${json}`)
      return report
    })
}
