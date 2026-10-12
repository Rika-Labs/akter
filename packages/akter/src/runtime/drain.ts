import { Context, type Duration, type Effect } from "effect"

/**
 * Whether this runner should receive traffic. A runner is ready once its
 * storage answers, its schemas are migrated and compatible (checked when the
 * layer builds), it registers at least one actor, job, or query layer, its
 * routing is up, a public runner has its currently assigned shards, and it
 * is not draining. Readiness never waits for actors to
 * wake or workflows to finish.
 */
export type Readiness =
  | { readonly ready: true }
  | {
      readonly ready: false
      /**
       * `draining` or `drained` after `drain`; `storage` when the database does
       * not answer; `routing` while acquiring shards or once sharding has
       * shut down; `peering` when a mutual TLS runner's certificate has
       * expired or its credentials have failed to load for too long;
       * `unregistered` before any actor, job, or query layer registers.
       */
      readonly reason: "draining" | "drained" | "storage" | "routing" | "peering" | "unregistered"
    }

/** What a drain did. */
export interface DrainReport {
  /**
   * `clean` when claims and background work stopped and every in-flight turn
   * and job attempt finished before the deadline; `deadline-expired`
   * otherwise, when the deadline interrupted what was still in flight.
   */
  readonly outcome: "clean" | "deadline-expired"
  /**
   * Turns the deadline interrupted. Each rolled back, unless its commit had
   * already been sent, in which case its receipt answers the caller's retry.
   */
  readonly interruptedTurns: number
  /**
   * Job attempts the deadline interrupted. The provider may have applied
   * each call, so each stays ambiguous, and another runner takes it over once
   * its lease ends.
   */
  readonly interruptedJobs: number
}

/**
 * Readiness and bounded graceful drain of this runner, provided by the
 * runtime that owns its shards.
 */
export class RuntimeControl extends Context.Service<
  RuntimeControl,
  {
    readonly readiness: Effect.Effect<Readiness>
    /**
     * Makes the runner unready, refuses new commands, and stops claiming
     * intents, timers, jobs, and subscription deliveries, releasing claimed
     * deliveries to other runners. In-flight turns and job attempts then
     * get until `deadline` to finish before they are interrupted. Pending
     * durable work stays in the database for other runners. The runner keeps
     * its shards until its layer closes, which hands them to the other runners
     * and ends workflow runs still live here, for another runner to replay; so
     * close the layer once the drain returns. A second call waits for the
     * first drain and returns its report.
     */
    readonly drain: (options: { readonly deadline: Duration.Input }) => Effect.Effect<DrainReport>
  }
>()("@rikalabs/akter/runtime/drain/RuntimeControl") {}
