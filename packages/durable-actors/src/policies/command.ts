import { Duration, Schema } from "effect"
import type { AnyCommand } from "../members/command.ts"
import type { AnyEffect, EffectPolicies } from "../members/effect.ts"

const Positive = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }))

const milliseconds = (duration: Duration.Input) => Positive.make(Duration.toMillis(duration))

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
  /** Per declared effect, keyed by tag: `retry`, `onSuccess`, and `onDeadLetter`. */
  readonly effects?: EffectPolicies<Effects, Command>
}

export interface TurnPolicy {
  readonly executionMs: number
  readonly lockWaitMs: number
  readonly deliveryMs: number
  readonly stateMaxBytes: number
  readonly idleMs: number
  readonly mailboxCapacity: number | "unbounded"
  readonly createdBy: string | undefined
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
  })
}
