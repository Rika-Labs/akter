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

export interface Registration {
  readonly name: string
  readonly singleton: boolean
  readonly policy: TurnPolicy
  readonly onDefect: (
    ref: ActorRef,
    cause: unknown,
    state: Effect.Effect<ReadonlyArray<readonly [string, string]>>,
  ) => Effect.Effect<void>
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
>()("durable-actors/handles/actors") {
  static readonly mint = <Id extends string>(actor: { readonly id: Schema.Codec<Id, string> }) =>
    Effect.gen(function* () {
      const actors = yield* Actors

      return yield* Schema.decodeEffect(actor.id)(yield* actors.mintActorId).pipe(Effect.orDie)
    })
}
