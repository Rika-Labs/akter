import { Context, Option, Schema } from "effect"

/** The authenticated identity a request acts as: the `subject` its credentials name. */
export const Principal = Schema.Struct({ subject: Schema.NonEmptyString })

/** The identity a request acts as. */
export type Principal = typeof Principal.Type

/** Names one actor: the `tenant` that owns it, its definition name as `actor`, and its `id`. */
export const ActorRef = Schema.Struct({
  tenant: Schema.NonEmptyString,
  actor: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
})

/** The identity of one actor. */
export type ActorRef = typeof ActorRef.Type

/** A caller authenticated as the principal `subject`. */
export const User = Schema.TaggedStruct("User", { subject: Schema.NonEmptyString })

/** A caller that presented no credentials; the default `CurrentCaller`. */
export const Anonymous = Schema.TaggedStruct("Anonymous", {})

/** Where a minted actor id came from: the minting command and its position in that turn. */
export const MintProof = Schema.Struct({
  commandId: Schema.String,
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})

/** Proof that a minted actor id was derived by a parent's turn. */
export type MintProof = typeof MintProof.Type

/**
 * A caller the framework creates for its own deliveries. `source` names the
 * mechanism (an actor's intent, a timer, cron, a workflow, an effect route, or
 * a subscription), `ref` the actor that sent it, and `onBehalfOf` the principal
 * of the turn that caused it. `mint` is set only on a minted child's creating
 * intent, and proves the child's id was derived by its parent.
 */
export const System = Schema.TaggedStruct("System", {
  source: Schema.Literals(["actor", "timer", "cron", "workflow", "effect", "subscription"]),
  ref: Schema.optional(ActorRef),
  onBehalfOf: Schema.optional(Principal),
  mint: Schema.optional(MintProof),
})

/** Who is calling: a `User`, `Anonymous`, or `System`. Tagged on `_tag`; `Caller.match` is exhaustive. */
export const Caller = Schema.Union([User, Anonymous, System]).pipe(Schema.toTaggedUnion("_tag"))

/** A `User`, `Anonymous`, or `System` caller. */
export type Caller = typeof Caller.Type

/**
 * The ambient caller, `Anonymous` by default. Authentication sets it at the
 * edge, and `Actor.as(caller)` scopes it around an Effect.
 */
export const CurrentCaller = Context.Reference<Caller>("durable-actors/CurrentCaller", {
  defaultValue: () => Anonymous.make({}),
})

/** The ambient tenant, `"default"` unless `Actor.tenant(tenant)` scopes another around an Effect. */
export const Tenant = Context.Reference<string>("durable-actors/Tenant", {
  defaultValue: () => "default",
})

/** The principal a caller acts as: a user's own, or the one a system caller acts on behalf of; none otherwise. */
export const principal = (caller: Caller): Option.Option<Principal> =>
  Caller.match(caller, {
    User: ({ subject }) => Option.some(Principal.make({ subject })),
    Anonymous: () => Option.none(),
    System: ({ onBehalfOf }) => Option.fromUndefinedOr(onBehalfOf),
  })

/** A string that is equal for two callers exactly when they are the same caller, mint proof included. */
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
