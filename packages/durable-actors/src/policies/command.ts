import { Data, Duration, Match, Schema } from "effect"
import type { AnyCommand } from "../members/command.ts"

const Milliseconds = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }))

const milliseconds = (duration: Duration.Input) => Milliseconds.make(Duration.toMillis(duration))

const CommandTimeout = Schema.TaggedStruct("CommandTimeout", { milliseconds: Milliseconds })

const LockWait = Schema.TaggedStruct("LockWait", { milliseconds: Milliseconds })

const DeliveryTimeout = Schema.TaggedStruct("DeliveryTimeout", { milliseconds: Milliseconds })

const StateMaxBytes = Schema.TaggedStruct("StateMaxBytes", { bytes: Milliseconds })

const HibernateAfter = Schema.TaggedStruct("HibernateAfter", { milliseconds: Milliseconds })

const MailboxCapacity = Schema.TaggedStruct("MailboxCapacity", { capacity: Milliseconds })

export const Commands = {
  timeout: (after: Duration.Input) => CommandTimeout.make({ milliseconds: milliseconds(after) }),
  lockWait: (after: Duration.Input) => LockWait.make({ milliseconds: milliseconds(after) }),
}

export const Delivery = {
  timeout: (after: Duration.Input) => DeliveryTimeout.make({ milliseconds: milliseconds(after) }),
}

export const State = { maxBytes: (bytes: number) => StateMaxBytes.make({ bytes }) }

export const Hibernate = {
  after: (after: Duration.Input) => HibernateAfter.make({ milliseconds: milliseconds(after) }),
}

export const Mailbox = { capacity: (capacity: number) => MailboxCapacity.make({ capacity }) }

export class CreatedBy<C extends AnyCommand = AnyCommand> extends Data.TaggedClass("CreatedBy")<{
  readonly command: C
}> {}

export const Lifecycle = {
  createdBy: <C extends AnyCommand>(command: C): CreatedBy<C> => new CreatedBy({ command }),
}

export type Policy<C extends AnyCommand = AnyCommand> =
  | typeof CommandTimeout.Type
  | typeof LockWait.Type
  | typeof DeliveryTimeout.Type
  | typeof StateMaxBytes.Type
  | typeof HibernateAfter.Type
  | typeof MailboxCapacity.Type
  | CreatedBy<C>

export const Policy = { Commands, Delivery, State, Hibernate, Mailbox, Lifecycle }

export interface TurnPolicy {
  readonly executionMs: number
  readonly lockWaitMs: number
  readonly deliveryMs: number
  readonly stateMaxBytes: number
  readonly idleMs: number
  readonly mailboxCapacity: number | "unbounded"
  readonly createdBy: string | undefined
}

export const resolvePolicies = (policies: ReadonlyArray<Policy>): TurnPolicy => {
  const seen = new Set<string>()

  const resolved: TurnPolicy = {
    executionMs: 30_000,
    lockWaitMs: 2_000,
    deliveryMs: 30_000,
    stateMaxBytes: 65_536,
    idleMs: 60_000,
    mailboxCapacity: "unbounded",
    createdBy: undefined,
  }

  for (const policy of policies) {
    if (seen.has(policy._tag)) throw new Error(`Duplicate policy: ${policy._tag}`)
    seen.add(policy._tag)
    Object.assign(
      resolved,
      Match.value(policy).pipe(
        Match.tagsExhaustive({
          CommandTimeout: ({ milliseconds }) => ({ executionMs: milliseconds }),
          LockWait: ({ milliseconds }) => ({ lockWaitMs: milliseconds }),
          DeliveryTimeout: ({ milliseconds }) => ({ deliveryMs: milliseconds }),
          StateMaxBytes: ({ bytes }) => ({ stateMaxBytes: bytes }),
          HibernateAfter: ({ milliseconds }) => ({ idleMs: milliseconds }),
          MailboxCapacity: ({ capacity }) => ({ mailboxCapacity: capacity }),
          CreatedBy: ({ command }) => ({ createdBy: command.tag }),
        }),
      ),
    )
  }

  return Object.freeze(resolved)
}
