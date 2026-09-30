import { Duration, Schema } from "effect"
import type { AnyCommand } from "../members/command.ts"

const Positive = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }))

const milliseconds = (duration: Duration.Input) => Positive.make(Duration.toMillis(duration))

/** Retention horizons may exceed the 32-bit timeouts: up to about ten years. */
const horizon = (duration: Duration.Input) =>
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 315_576_000_000 })).make(
    Duration.toMillis(duration),
  )

/**
 * Serializable actor limits, retention, and lifecycle settings; each key has
 * exactly one meaning and one default. What the actor does (who creates it,
 * its schedules, its jobs) is declared on the definition, not here.
 */
export interface Policy {
  /** Idle time before the activation sleeps. Default 60 seconds. */
  readonly hibernateAfter?: Duration.Input
  /**
   * Deadline for one command turn's transaction and one query's execution.
   * It does not bound a workflow or a live session. Default 30 seconds.
   */
  readonly executionTimeout?: Duration.Input
  /** Deadline for acquiring the generation lock. Default 2 seconds. */
  readonly lockWait?: Duration.Input
  /** How long a caller waits for a reply; the turn itself is not cancelled. Default 30 seconds. */
  readonly deliveryTimeout?: Duration.Input
  /** Maximum UTF-8 bytes of the encoded state object. Default 65,536. */
  readonly maxStateBytes?: number
  /** Maximum queued commands per activation. Default unbounded. */
  readonly mailboxCapacity?: number
  /**
   * How long a receipt is kept after its command id is issued; a timer's
   * receipt counts from its due time. A receipt is never pruned before its id
   * expires, nor while an intent or job with its id is still pending.
   * Default 7 days.
   */
  readonly keepReceipts?: Duration.Input
  /**
   * How long an event is kept after it is emitted. Pruning removes only an
   * actor's oldest events, and replay after a pruned cursor fails
   * `RetentionGap`. Default 30 days.
   */
  readonly keepEvents?: Duration.Input
  /**
   * Maximum bytes across all of one actor's blob entries; a write past it is
   * a defect of the turn. Default 67,108,864 (64 MiB).
   */
  readonly maxBlobBytes?: number
  /**
   * Maximum entries across all of one actor's blobs; a write that would
   * create an entry past it is a defect of the turn, while existing entries
   * stay writable. Default 10,000.
   */
  readonly maxBlobEntries?: number
  /**
   * How long a finished workflow execution keeps its result for `poll` after
   * it finishes. Must be at least the deployment's retry window. Default 7 days.
   */
  readonly keepWorkflows?: Duration.Input
  /** A schedule tick later than this after its scheduled time is skipped. Default 1 day. */
  readonly maxScheduleLag?: Duration.Input
  /**
   * Whether open connections keep the activation awake. `"park"` (default)
   * lets it hibernate with sockets open at their holders; `"keepAwake"`
   * counts an open connection as activity.
   */
  readonly connections?: "park" | "keepAwake"
  /** Longest time a connection runs on one authorization check, 1 second to 1 hour. Default 60 seconds. */
  readonly reauthorizeEvery?: Duration.Input
  /** Limits on the watches of this actor's `watch: true` queries. */
  readonly watch?: {
    /** Watches open on one actor at once; the next fails `RunnerAtCapacity`. Default 1,000. */
    readonly maxPerActor?: number
    /** The least time between two reruns of one watch. Default 100 milliseconds. */
    readonly minInterval?: Duration.Input
    /**
     * How often a watch reruns whether or not a commit signal arrived, so a
     * signal lost to a broadcast gap or an owner's death, or a change no
     * commit reports, is shown within this time. 5 seconds to 1 hour.
     * Default 30 seconds.
     */
    readonly reconcileEvery?: Duration.Input
  }
  /**
   * The actor types that may subscribe to this actor's events, by name, so
   * this definition never imports its subscribers. These are actor type
   * names, not user principals. A subscription on any other type fails at
   * `Actor.make`. Omitted, every type in the tenant may.
   */
  readonly allowedSubscriberTypes?: ReadonlyArray<string>
  /**
   * How long past `keepEvents` subscriptions to this actor may hold its
   * events back from pruning. An event older than both is pruned, and a
   * subscriber behind it receives a `RetentionGap`. Default 7 days.
   */
  readonly holdEventsForSubscribers?: Duration.Input
}

/** A `Policy` resolved for the runtime: every default applied and every duration in whole milliseconds. */
export interface TurnPolicy {
  readonly executionMs: number
  readonly lockWaitMs: number
  readonly deliveryMs: number
  readonly stateMaxBytes: number
  readonly idleMs: number
  readonly mailboxCapacity: number | "unbounded"
  readonly createdBy: string | undefined
  readonly keepReceiptsMs: number
  readonly keepEventsMs: number
  readonly blobMaxBytes: number
  readonly blobMaxEntries: number
  readonly connections: "park" | "keepAwake"
  readonly reauthorizeMs: number
  readonly watch: {
    readonly maxPerActor: number
    readonly minIntervalMs: number
    readonly reconcileMs: number
  }
  readonly keepWorkflowsMs: number
  readonly cronSkipMs: number
  readonly subscribers: ReadonlyArray<string> | undefined
  readonly holdEventsMs: number
}

/**
 * Applies the defaults of `declared` and validates each bound: durations run
 * from 1 ms to 2^31 - 1 ms, retention horizons up to about ten years, and
 * `reauthorizeEvery` from 1 second to 1 hour, and `watch.reconcileEvery` from
 * 5 seconds to 1 hour. Throws when a value is out of range or `createdBy` is
 * not one of `commands`.
 */
export const resolvePolicy = (policy: {
  readonly declared: Policy | undefined
  readonly createdBy: AnyCommand | undefined
  readonly commands: ReadonlyArray<AnyCommand>
}): TurnPolicy => {
  const { declared, createdBy, commands } = policy

  if (createdBy !== undefined && !commands.includes(createdBy))
    throw new Error("createdBy must be a command of this actor")

  return Object.freeze({
    executionMs: milliseconds(declared?.executionTimeout ?? "30 seconds"),
    lockWaitMs: milliseconds(declared?.lockWait ?? "2 seconds"),
    deliveryMs: milliseconds(declared?.deliveryTimeout ?? "30 seconds"),
    stateMaxBytes: Positive.make(declared?.maxStateBytes ?? 65_536),
    idleMs: milliseconds(declared?.hibernateAfter ?? "60 seconds"),
    mailboxCapacity:
      declared?.mailboxCapacity === undefined
        ? "unbounded"
        : Positive.make(declared.mailboxCapacity),
    createdBy: createdBy?.tag,
    keepReceiptsMs: horizon(declared?.keepReceipts ?? "7 days"),
    keepEventsMs: horizon(declared?.keepEvents ?? "30 days"),
    blobMaxBytes: Positive.make(declared?.maxBlobBytes ?? 67_108_864),
    blobMaxEntries: Positive.make(declared?.maxBlobEntries ?? 10_000),
    connections: declared?.connections ?? "park",
    reauthorizeMs: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 3_600_000 })).make(
      Duration.toMillis(declared?.reauthorizeEvery ?? "60 seconds"),
    ),
    watch: {
      maxPerActor: Positive.make(declared?.watch?.maxPerActor ?? 1_000),
      minIntervalMs: milliseconds(declared?.watch?.minInterval ?? "100 millis"),
      reconcileMs: Schema.Int.check(Schema.isBetween({ minimum: 5_000, maximum: 3_600_000 })).make(
        Duration.toMillis(declared?.watch?.reconcileEvery ?? "30 seconds"),
      ),
    },
    keepWorkflowsMs: horizon(declared?.keepWorkflows ?? "7 days"),
    cronSkipMs: horizon(declared?.maxScheduleLag ?? "1 day"),
    subscribers:
      declared?.allowedSubscriberTypes === undefined
        ? undefined
        : [...declared.allowedSubscriberTypes],
    holdEventsMs: horizon(declared?.holdEventsForSubscribers ?? "7 days"),
  })
}
