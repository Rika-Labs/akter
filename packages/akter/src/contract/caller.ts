import { Schema } from "effect"

/** A caller authenticated as `subject` by the transport. */
export const User = Schema.TaggedStruct("User", { subject: Schema.NonEmptyString })

/** A caller authenticated as `subject` by the transport. */
export type User = typeof User.Type

/** A caller that presented no credentials. */
export const Anonymous = Schema.TaggedStruct("Anonymous", {})

/** A caller that presented no credentials. */
export type Anonymous = typeof Anonymous.Type

/**
 * A call the engine makes on an actor's behalf. `source` names the mechanism (`send`, `timer`,
 * `cron`, `job`, `operator`, `process`), `subject` names the origin (`actor:<Type>/<id>`,
 * `job:<jobId>`, `cron:<Type>`, `operator:<id>`) so that `caller.subject` types for every caller
 * an actor admits once `access` excludes `Anonymous`, `ref` is the originating actor's address and
 * `onBehalfOf` the principal of the command that caused the call.
 */
export const System = Schema.TaggedStruct("System", {
  source: Schema.Literals(["send", "timer", "cron", "job", "operator", "process"]),
  subject: Schema.String,
  ref: Schema.optional(Schema.String),
  onBehalfOf: Schema.optional(Schema.String),
})

/** A call the engine makes on an actor's behalf. */
export type System = typeof System.Type

/** Who is calling: tagged on `_tag`; `Caller.match` is exhaustive and `Caller.guards` narrows. */
export const Caller = Schema.Union([User, Anonymous, System]).pipe(Schema.toTaggedUnion("_tag"))

/** Who is calling. */
export type Caller = typeof Caller.Type

/** Builds a `User` caller. */
export const user = (subject: string): User => User.make({ subject })

/** The `Anonymous` caller. */
export const anonymous: Anonymous = Anonymous.make({})

/** Builds a `System` caller. */
export const system = (fields: Omit<System, "_tag">): System => System.make(fields)

/** True for a `User` caller; usable as an actor's `access` guard. */
export const isUser = (caller: Caller): caller is User => Caller.guards.User(caller)

/** True for a `System` caller. */
export const isSystem = (caller: Caller): caller is System => Caller.guards.System(caller)

/** True for every caller except `Anonymous`; the default `access` guard. */
export const isAuthenticated = (caller: Caller): caller is User | System =>
  !Caller.guards.Anonymous(caller)

/**
 * The principal a call acts for: a user's subject, a system caller's `onBehalfOf`, or nothing
 * for anonymous callers. Recorded as `onBehalfOf` on every call the engine makes on its behalf.
 */
export const principal = (caller: Caller): string | undefined =>
  Caller.match(caller, {
    User: ({ subject }) => subject,
    Anonymous: () => undefined,
    System: ({ onBehalfOf }) => onBehalfOf,
  })
