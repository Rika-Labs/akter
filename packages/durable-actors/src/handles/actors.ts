import { Context, Effect, Schema, Scope } from "effect"
import type { ActorError } from "../errors/actor.ts"
import { ActorRef, Caller } from "../identity/caller.ts"

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
  readonly run: (
    request: Request,
    state: ReadonlyArray<readonly [string, string]>,
  ) => Effect.Effect<BusinessResult, BusinessResult>
}

export interface Registration {
  readonly name: string
  readonly commands: ReadonlyMap<string, RegisteredCommand>
}

export class Actors extends Context.Service<
  Actors,
  {
    readonly register: (actor: Registration) => Effect.Effect<void, never, Scope.Scope>
    readonly execute: (request: Request) => Effect.Effect<Outcome, ActorError>
    readonly mintCommandId: Effect.Effect<string>
    readonly mintActorId: Effect.Effect<string>
  }
>()("durable-actors/handles/actors") {}
