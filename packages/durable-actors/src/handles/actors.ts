import { Context, Effect, Schema, Scope } from "effect"
import type { ActorError } from "../errors/actor.ts"
import type { RetentionGap, UnknownCursor } from "../errors/events.ts"
import { ActorRef, Caller } from "../identity/caller.ts"
import type { ExecutorContext } from "../contexts/effect.ts"
import type { TurnPolicy } from "../policies/command.ts"
import type { StagedOutbox } from "./intents.ts"
import type { AnyBlob } from "../members/blob.ts"
import type { BlobAccess, BlobScope } from "../state/blob.ts"
import type { AnyOwnedTable, TableAccess, TableScope } from "../tables/owned.ts"

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
  /** `state` lists every stored key; the turn deletes any other stored key. */
  readonly complete: boolean
  /** Encoded events in emit order, appended with the commit. */
  readonly events: ReadonlyArray<EmittedEvent>
  /** Intents and effects to commit with the turn; a declared failure stages none. */
  readonly outbox: StagedOutbox
}

export interface EmittedEvent {
  readonly tag: string
  readonly value: string
}

export interface StoredEvent {
  readonly cursor: string
  readonly commandId: string
  readonly value: string
  readonly timestampMs: number
}

/** Reads one actor's committed events of one tag after an exclusive cursor, up to the query's snapshot. */
export type EventReader = (
  tag: string,
  after: string | undefined,
) => Effect.Effect<ReadonlyArray<StoredEvent>, UnknownCursor | RetentionGap>

export interface RegisteredCommand {
  readonly internal: boolean
  readonly run: (
    request: Request,
    state: ReadonlyArray<readonly [string, string]>,
  ) => Effect.Effect<BusinessResult, BusinessResult>
}

/** A command an effect's outcome is delivered to, with its encoded input. */
export interface EffectRoute {
  readonly command: string
  readonly payload: string
}

/** How one executor attempt ended without a result. */
export interface EffectFailure {
  readonly cause: string
  /** True when the provider may have applied the call anyway. */
  readonly ambiguous: boolean
  /** Retrying cannot help, so the effect is dead-lettered now. */
  readonly final?: boolean
}

export interface RegisteredEffect {
  /** Total attempts before the effect is dead-lettered. */
  readonly attempts: number
  /** The wait after failed attempt `n` is `min(baseMs × 2^(n − 1), maxMs)`. */
  readonly backoff: { readonly baseMs: number; readonly maxMs: number }
  /** Runs one attempt; succeeds with the `onSuccess` route, if declared. */
  readonly execute: (
    payload: string,
    context: ExecutorContext,
  ) => Effect.Effect<EffectRoute | undefined, EffectFailure>
  /** The `onDeadLetter` route for an exhausted effect, if declared. */
  readonly deadLetter: (
    payload: string,
    letter: {
      readonly effectId: string
      readonly attempts: number
      readonly cause: string
      readonly ambiguous: boolean
    },
  ) => Effect.Effect<EffectRoute | undefined>
}

export interface EffectRegistration {
  readonly name: string
  /** The effect layer's build context; executor attempts run in it. */
  readonly services: Context.Context<never>
  readonly effects: ReadonlyMap<string, RegisteredEffect>
}

/** A query reads committed state; it never activates, fences, or receipts. */
export interface RegisteredQuery {
  readonly run: (
    request: Request,
    state: ReadonlyArray<readonly [string, string]>,
    cursor: string,
    events: EventReader,
  ) => Effect.Effect<Outcome>
}

export interface QueryRegistration {
  readonly name: string
  readonly placement: "tenant" | "actor"
  readonly tables: ReadonlyArray<AnyOwnedTable>
  readonly blobs: ReadonlyArray<AnyBlob>
  readonly queries: ReadonlyMap<string, RegisteredQuery>
}

export interface Registration {
  readonly name: string
  readonly singleton: boolean
  readonly placement: "tenant" | "actor"
  readonly policy: TurnPolicy
  readonly tables: ReadonlyArray<AnyOwnedTable>
  readonly blobs: ReadonlyArray<AnyBlob>
  readonly commands: ReadonlyMap<string, RegisteredCommand>
}

/** Runtime-only capabilities; package entry points export only Actors. */
export class InternalActors extends Context.Service<
  InternalActors,
  {
    readonly register: (actor: Registration) => Effect.Effect<void, never, Scope.Scope>
    readonly execute: (request: Request) => Effect.Effect<Outcome, ActorError>
    /**
     * Delivers a committed intent. The obligation was admitted by its sending
     * turn, so external access and command-id expiry are not checked again.
     */
    readonly deliver: (request: Request) => Effect.Effect<Outcome, ActorError>
    /** Runs relay passes until no due intent remains; used by `ActorTest.advance`. */
    readonly drainOutbox: Effect.Effect<void>
    readonly registerQueries: (actor: QueryRegistration) => Effect.Effect<void, never, Scope.Scope>
    readonly registerEffects: (actor: EffectRegistration) => Effect.Effect<void, never, Scope.Scope>
    readonly query: (request: Request) => Effect.Effect<Outcome, ActorError>
    readonly mintActorId: Effect.Effect<string>
    /**
     * Binds owned-table capabilities to the calling fiber's turn or query.
     * Writable access requires the turn transaction and never opens its own.
     */
    readonly tables: (scope: TableScope, write: boolean) => Effect.Effect<TableAccess>
    /** The Cluster shard that places `ref`'s activation, as stored in runner shard locks. */
    readonly shardId: (ref: ActorRef) => Effect.Effect<string>
    /** Binds blob capabilities the same way; writable access requires the turn transaction. */
    readonly blobs: (scope: BlobScope, write: boolean) => Effect.Effect<BlobAccess>
    /** The blob names a registered actor type declares, for test inspection. */
    readonly declaredBlobs: (actor: string) => ReadonlyArray<string>
  }
>()("durable-actors/handles/actors/InternalActors") {}

export class Actors extends Context.Service<
  Actors,
  {
    /** Mints a command id for `Actor.commandId`, so a caller can retry one operation across processes. */
    readonly mintCommandId: Effect.Effect<string>
  }
>()("durable-actors/handles/actors") {}
