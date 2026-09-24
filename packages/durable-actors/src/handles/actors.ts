import { Context, Effect, Schema, Scope } from "effect"
import type { ActorError } from "../errors/actor.ts"
import { ActorRef, Caller } from "../identity/caller.ts"
import type { TurnPolicy } from "../policies/command.ts"

export const Outcome = Schema.TaggedUnion({
  Success: { value: Schema.String },
  Failure: { value: Schema.String },
  Defect: { cause: Schema.Defect() },
})

export type Outcome = typeof Outcome.Type

export const Request = Schema.Struct({
  ref: ActorRef,
  caller: Caller,
  command: Schema.NonEmptyString,
  commandId: Schema.String,
  payload: Schema.String,
})

export type Request = typeof Request.Type

export interface BusinessResult {
  readonly outcome: Outcome
  readonly state: ReadonlyArray<readonly [string, string]>
}

export interface RegisteredCommand {
  readonly internal: boolean
  readonly run: (
    request: Request,
    state: ReadonlyArray<readonly [string, string]>,
  ) => Effect.Effect<BusinessResult, BusinessResult>
}

/** A query reads committed state; it never activates, fences, or receipts. */
export interface RegisteredQuery {
  readonly run: (
    request: Request,
    state: ReadonlyArray<readonly [string, string]>,
  ) => Effect.Effect<Outcome>
}

export interface QueryRegistration {
  readonly name: string
  readonly placement: "tenant" | "actor"
  readonly queries: ReadonlyMap<string, RegisteredQuery>
}

export interface Registration {
  readonly name: string
  readonly singleton: boolean
  readonly placement: "tenant" | "actor"
  readonly policy: TurnPolicy
  readonly commands: ReadonlyMap<string, RegisteredCommand>
}

/** Runtime-only capabilities; package entry points export only Actors. */
export class InternalActors extends Context.Service<
  InternalActors,
  {
    readonly register: (actor: Registration) => Effect.Effect<void, never, Scope.Scope>
    readonly execute: (request: Request) => Effect.Effect<Outcome, ActorError>
    readonly registerQueries: (actor: QueryRegistration) => Effect.Effect<void, never, Scope.Scope>
    readonly query: (request: Request) => Effect.Effect<Outcome, ActorError>
    readonly mintActorId: Effect.Effect<string>
  }
>()("durable-actors/handles/actors/InternalActors") {}

export class Actors extends Context.Service<
  Actors,
  {
    /** Mints a command id for `Actor.commandId`, so a caller can retry one operation across processes. */
    readonly mintCommandId: Effect.Effect<string>
  }
>()("durable-actors/handles/actors") {}
