import { Context, Option, Schema } from "effect"

export const Principal = Schema.Struct({ subject: Schema.NonEmptyString })

export type Principal = typeof Principal.Type

export const ActorRef = Schema.Struct({
  tenant: Schema.NonEmptyString,
  actor: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
})

export type ActorRef = typeof ActorRef.Type

export const User = Schema.TaggedStruct("User", { subject: Schema.NonEmptyString })

export const Anonymous = Schema.TaggedStruct("Anonymous", {})

/** Where a minted actor id came from: the minting command and its position in that turn. */
export const MintProof = Schema.Struct({
  commandId: Schema.String,
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})

export type MintProof = typeof MintProof.Type

export const System = Schema.TaggedStruct("System", {
  source: Schema.Literals(["actor", "timer", "cron", "workflow", "effect"]),
  ref: Schema.optional(ActorRef),
  onBehalfOf: Schema.optional(Principal),
  mint: Schema.optional(MintProof),
})

export const Caller = Schema.Union([User, Anonymous, System]).pipe(Schema.toTaggedUnion("_tag"))

export type Caller = typeof Caller.Type

export const CurrentCaller = Context.Reference<Caller>("durable-actors/CurrentCaller", {
  defaultValue: () => Anonymous.make({}),
})

export const Tenant = Context.Reference<string>("durable-actors/Tenant", {
  defaultValue: () => "default",
})

export const principal = (caller: Caller): Option.Option<Principal> =>
  Caller.match(caller, {
    User: ({ subject }) => Option.some(Principal.make({ subject })),
    Anonymous: () => Option.none(),
    System: ({ onBehalfOf }) => Option.fromUndefinedOr(onBehalfOf),
  })

export const callerKey = (caller: Caller): string =>
  JSON.stringify(
    Caller.match(caller, {
      User: ({ subject }) => ["User", subject],
      Anonymous: () => ["Anonymous"],
      System: ({ source, ref, onBehalfOf, mint }) => {
        const key = [
          "System",
          source,
          ref === undefined ? null : [ref.tenant, ref.actor, ref.id],
          onBehalfOf?.subject ?? null,
        ]

        return mint === undefined ? key : [...key, [mint.commandId, mint.ordinal]]
      },
    }),
  )
