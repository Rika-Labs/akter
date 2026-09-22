import { Context, Schema } from "effect"

export const User = Schema.TaggedStruct("User", { subject: Schema.NonEmptyString })

export const Anonymous = Schema.TaggedStruct("Anonymous", {})

export const Caller = Schema.Union([User, Anonymous]).pipe(Schema.toTaggedUnion("_tag"))

export type Caller = typeof Caller.Type

export const CurrentCaller = Context.Reference<Caller>("durable-actors/CurrentCaller", {
  defaultValue: () => Anonymous.make({}),
})

export const Tenant = Context.Reference<string>("durable-actors/Tenant", {
  defaultValue: () => "default",
})

export const ActorRef = Schema.Struct({
  tenant: Schema.NonEmptyString,
  actor: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
})

export type ActorRef = typeof ActorRef.Type

export const callerKey = (caller: Caller): string =>
  JSON.stringify(
    Caller.match(caller, {
      User: ({ subject }) => ["User", subject],
      Anonymous: () => ["Anonymous"],
    }),
  )
