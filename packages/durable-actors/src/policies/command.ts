import { Duration, Schema } from "effect"
import type { AnyCommand } from "../members/command.ts"
import type { AnyEffect, EffectPolicies } from "../members/effect.ts"

const Positive = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }))

const milliseconds = (duration: Duration.Input) => Positive.make(Duration.toMillis(duration))

/** Retention horizons may exceed the 32-bit timeouts: up to about ten years. */
const horizon = (duration: Duration.Input) =>
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 315_576_000_000 })).make(
    Duration.toMillis(duration),
  )

/** Serializable actor policies; each key has exactly one meaning and one default. */
export interface Policy<
  Command extends AnyCommand = AnyCommand,
  Effects extends AnyEffect = never,
> {
  /** Idle time before the activation sleeps. Default 60 seconds. */
  readonly hibernateAfter?: Duration.Input
  /** Deadline for the whole turn transaction. Default 30 seconds. */
  readonly commandTimeout?: Duration.Input
  /** Deadline for acquiring the generation lock. Default 2 seconds. */
  readonly lockWait?: Duration.Input
  /** How long a caller waits for a reply; the turn itself is not cancelled. Default 30 seconds. */
  readonly deliveryTimeout?: Duration.Input
  /** Maximum UTF-8 bytes of the encoded state object. Default 65,536. */
  readonly maxStateBytes?: number
  /** Maximum queued commands per activation. Default unbounded. */
  readonly mailboxCapacity?: number
  /** The only command that may create the actor; other commands fail `NotCreated` until it commits. */
  readonly createdBy?: Command
  /**
   * How long a receipt is kept after its command id is issued; a timer's
   * receipt counts from its due time. A receipt is never pruned before its id
   * expires, nor while an intent or effect with its id is still pending.
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
   * How long a finished workflow execution keeps its result for `poll` after
   * it finishes. Must be at least the deployment's retry window. Default 7 days.
   */
  readonly keepWorkflows?: Duration.Input
  /** Per declared effect, keyed by tag: `retry`, `onSuccess`, and `onDeadLetter`. */
  readonly effects?: EffectPolicies<Effects, Command>
  /**
   * Whether open connections keep the activation awake. `"park"` (default)
   * lets it hibernate with sockets open at their holders; `"keepAwake"`
   * counts an open connection as activity.
   */
  readonly connections?: "park" | "keepAwake"
  /** Longest time a connection runs on one authorization check, 1 second to 1 hour. Default 60 seconds. */
  readonly reauthorizeEvery?: Duration.Input
}

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
  readonly connections: "park" | "keepAwake"
  readonly reauthorizeMs: number
  readonly keepWorkflowsMs: number
}

export const resolvePolicy = (policy: {
  readonly declared: Policy | undefined
  readonly commands: ReadonlyArray<AnyCommand>
}): TurnPolicy => {
  const { declared, commands } = policy

  if (declared?.createdBy !== undefined && !commands.includes(declared.createdBy))
    throw new Error("policy.createdBy must belong to this actor")

  return Object.freeze({
    executionMs: milliseconds(declared?.commandTimeout ?? "30 seconds"),
    lockWaitMs: milliseconds(declared?.lockWait ?? "2 seconds"),
    deliveryMs: milliseconds(declared?.deliveryTimeout ?? "30 seconds"),
    stateMaxBytes: Positive.make(declared?.maxStateBytes ?? 65_536),
    idleMs: milliseconds(declared?.hibernateAfter ?? "60 seconds"),
    mailboxCapacity:
      declared?.mailboxCapacity === undefined
        ? "unbounded"
        : Positive.make(declared.mailboxCapacity),
    createdBy: declared?.createdBy?.tag,
    keepReceiptsMs: horizon(declared?.keepReceipts ?? "7 days"),
    keepEventsMs: horizon(declared?.keepEvents ?? "30 days"),
    blobMaxBytes: Positive.make(declared?.maxBlobBytes ?? 67_108_864),
    connections: declared?.connections ?? "park",
    reauthorizeMs: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 3_600_000 })).make(
      Duration.toMillis(declared?.reauthorizeEvery ?? "60 seconds"),
    ),
    keepWorkflowsMs: horizon(declared?.keepWorkflows ?? "7 days"),
  })
}
