import type { Transport } from "../runtime/connections/transport.ts"
import type { Holder } from "../runtime/connections/holder.ts"
import { Context, Effect, type Exit, Schema, Scope, type Stream } from "effect"
import type { ActorError } from "../errors/actor.ts"
import type { RetentionGap, UnknownCursor } from "../errors/events.ts"
import { ActorRef, Caller } from "../identity/caller.ts"
import type { ConnectionCommands } from "../identity/command.ts"
import type { MintInput } from "../identity/mint.ts"
import type { ExecutorContext } from "../contexts/effect.ts"
import type { TurnPolicy } from "../policies/command.ts"
import type { Swept } from "../runtime/storage/retention.ts"
import type { StagedOutbox } from "./intents.ts"
import type { AnyBlob } from "../members/blob.ts"
import type { BlobAccess, BlobScope } from "../state/blob.ts"
import type { AnyOwnedTable, TableAccess, TableScope } from "../tables/owned.ts"
import type { RecordedExit, StoredResult, WorkflowContext } from "../contexts/workflow.ts"
import type { AnyWorkflow } from "../members/workflow.ts"

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
  /**
   * Set only by the runtime on external admission. Such a turn rejects an
   * expired id that has no receipt, so pruning a receipt while its retry
   * waits for the turn cannot run the command again.
   */
  external: Schema.optionalKey(Schema.Boolean),
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
  /** Frames to send to open connections once the turn commits; a declared failure sends none. */
  readonly broadcasts?: ReadonlyArray<Broadcast>
}

/** One encoded frame for a connection member's open connections. */
export interface Broadcast {
  readonly member: string
  readonly frame: string
  /** The cursor of the event the frame was sent from. */
  readonly event?: string | undefined
  readonly to?: ReadonlyArray<string> | undefined
  readonly except?: ReadonlyArray<string> | undefined
}

/** An open connection as a turn or connection handler lists it. */
export interface OpenConnection {
  readonly connectionId: string
  readonly caller: Caller
  readonly session: string | undefined
}

/** Lists one connection member's open connections. */
export type ConnectionLister = (member: string) => Effect.Effect<ReadonlyArray<OpenConnection>>

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
  limit: number,
) => Effect.Effect<ReadonlyArray<StoredEvent>, UnknownCursor | RetentionGap>

export interface RegisteredCommand {
  readonly internal: boolean
  readonly run: (
    request: Request,
    state: ReadonlyArray<readonly [string, string]>,
    connections?: ConnectionLister,
  ) => Effect.Effect<BusinessResult, BusinessResult>
}

/** What one connection handler is asked to do. */
export const ConnectionPhase = Schema.TaggedUnion({
  Open: { params: Schema.String },
  Frame: { frame: Schema.String },
  Close: { reason: Schema.String },
  Resync: { after: Schema.UndefinedOr(Schema.String) },
})

export type ConnectionPhase = typeof ConnectionPhase.Type

/** The committed view and capabilities one connection handler runs with. */
export interface ConnectionInput {
  readonly ref: ActorRef
  readonly connectionId: string
  readonly member: string
  readonly caller: Caller
  readonly resumed: boolean
  readonly cursor: string
  readonly state: ReadonlyArray<readonly [string, string]>
  readonly session: string | undefined
  readonly connections: ConnectionLister
  readonly events: EventReader
  /** Present for open and frame phases, so command calls get redelivery-stable ids. */
  readonly commands?: ConnectionCommands | undefined
}

/** What a connection handler leaves to write and send once it returns. */
export interface ConnectionResult {
  /** The encoded session after the handler, or undefined when it has none. */
  readonly session: string | undefined
  readonly changed: boolean
  readonly sends: ReadonlyArray<{ readonly frame: string; readonly event?: string | undefined }>
  readonly broadcasts: ReadonlyArray<Broadcast>
  readonly close: boolean
}

export interface RegisteredConnection {
  readonly stampCursor: boolean
  readonly hasResync: boolean
  /** Fails with an encoded declared error only while opening. */
  readonly run: (
    input: ConnectionInput,
    phase: ConnectionPhase,
  ) => Effect.Effect<ConnectionResult, { readonly failure: string }>
}

/** The committed view one stream handler starts from, and its live event feed. */
export interface StreamInput {
  readonly ref: ActorRef
  readonly caller: Caller
  /** The committed event head when the subscription started. */
  readonly cursor: string
  readonly state: ReadonlyArray<readonly [string, string]>
  readonly events: EventReader
  /** Committed events of one tag after `after`, then each one as its turn commits. */
  readonly follow: (
    tag: string,
    after: string | undefined,
  ) => Stream.Stream<StoredEvent, UnknownCursor | RetentionGap>
}

export interface RegisteredStream {
  /** Encoded elements; a declared failure is encoded, anything else is a defect. */
  readonly run: (
    payload: string,
    input: StreamInput,
  ) => Stream.Stream<string, { readonly failure: string }>
}

/** A command an effect's outcome is delivered to, with its encoded input. */
export interface EffectRoute {
  readonly command: string
  readonly payload: string
}

/**
 * The most attempts any effect may declare: `retry.times` is at most 100 in
 * every runner version. A final failure records this count, so every runner,
 * whatever its retry policy, treats the row as exhausted.
 */
export const MAX_EFFECT_ATTEMPTS = 101

/** How one executor attempt ended without a result. */
export interface EffectFailure {
  readonly cause: string
  /** True when the provider may have applied the call anyway. */
  readonly ambiguous: boolean
  /** Retrying cannot help, so the effect is dead-lettered now. */
  readonly final?: boolean
}

/** What the relay gives one attempt; the executor sees it as `X.Executor`. */
export type AttemptContext = Omit<ExecutorContext, "progress"> & {
  /** Offers one encoded progress frame to the attempt's slot. */
  /** False when progress reports go nowhere, so frames need not be encoded. */
  readonly reporting: () => boolean
  readonly report: (frame: Uint8Array) => Effect.Effect<void>
}

export interface RegisteredEffect {
  /** Total attempts before the effect is dead-lettered. */
  readonly attempts: number
  /** The least time between two progress frames of one attempt; undefined when the effect declares no progress. */
  readonly progressEveryMs: number | undefined
  /** The wait after failed attempt `n` is `min(baseMs × 2^(n − 1), maxMs)`. */
  readonly backoff: { readonly baseMs: number; readonly maxMs: number }
  /** Attempts running at once per actor across runners; unlimited when undefined. */
  readonly perActor: number | undefined
  /** Whether the effect declares an `onCancelled` route. */
  readonly routesCancelled: boolean
  /**
   * Runs one attempt; succeeds with the `onSuccess` route and the
   * `onCancelled` route of its result, each if declared, or with the reason
   * `onSuccess` rejects the result.
   */
  readonly execute: (
    payload: string,
    context: AttemptContext,
  ) => Effect.Effect<
    {
      readonly success: EffectRoute | undefined
      readonly cancelled: EffectRoute | undefined
      /** Why `onSuccess` cannot accept the result, when it cannot. */
      readonly rejected: EffectFailure | undefined
    },
    EffectFailure
  >
  /** The `onCancelled` route for a cancelled effect without a result, if declared. */
  readonly cancelled: (
    payload: string,
    letter: {
      readonly effectId: string
      readonly attempts: number
      readonly outcome: { readonly _tag: "Failed" | "Unknown"; readonly cause: string }
      readonly ambiguous: boolean
    },
  ) => Effect.Effect<EffectRoute | undefined>
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
  /** `commandTimeout`: a query's reads are cancelled on the server past it. */
  readonly timeoutMs: number
  readonly tables: ReadonlyArray<AnyOwnedTable>
  readonly blobs: ReadonlyArray<AnyBlob>
  readonly queries: ReadonlyMap<string, RegisteredQuery>
}

export interface Registration {
  readonly name: string
  readonly singleton: boolean
  /** Unkeyed with `policy.createdBy`: its UUIDv8 ids come only from `turn.mint`. */
  readonly mintable: boolean
  /** The deployment's default tenant: the ambient `Tenant` when the actor's layer is built. */
  readonly tenant: string
  readonly placement: "tenant" | "actor"
  readonly policy: TurnPolicy
  readonly tables: ReadonlyArray<AnyOwnedTable>
  readonly blobs: ReadonlyArray<AnyBlob>
  /**
   * Resolves one activation's commands in the activation's scope. A singleton
   * runs its build here, so fibers it forks live as long as the activation.
   */
  readonly activate: (
    ref: ActorRef,
  ) => Effect.Effect<ReadonlyMap<string, RegisteredCommand>, never, Scope.Scope>
  readonly connections: ReadonlyMap<string, RegisteredConnection>
  readonly streams: ReadonlyMap<string, RegisteredStream>
  /** Tags of the events this actor type serves as event feeds. */
  readonly feeds: ReadonlySet<string>
  /** Workflow members with their bodies, keyed by tag. */
  readonly workflows: ReadonlyMap<string, RegisteredWorkflow>
}

/** A workflow member bound to its body when the actor's layer was built. */
export interface RegisteredWorkflow {
  readonly member: AnyWorkflow
  /** The member's constructors when the layer was built; any other step dies. */
  readonly steps: ReadonlyMap<string, { readonly kind: string }>
  /** The execution key of an encoded input; `fallback` when the member declares no key. */
  readonly key: (payload: string, fallback: string) => Effect.Effect<string>
  /** Runs the body once from its start; recorded steps replay instead of running again. */
  readonly run: (
    payload: string,
    context: WorkflowContext,
  ) => Effect.Effect<Exit.Exit<unknown, unknown>>
  readonly encodeExit: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<RecordedExit>
}

/** One execution's committed status as `poll` reads it. */
export interface WorkflowStatus {
  readonly finished: boolean
  /** The recorded exit, once finished; `Interrupt` for an interrupted execution. */
  readonly result: StoredResult | undefined
}

/** Runtime-only capabilities; package entry points export only Actors. */
export class InternalActors extends Context.Service<
  InternalActors,
  {
    readonly register: (actor: Registration) => Effect.Effect<void, never, Scope.Scope>
    readonly transport: Transport
    /** This runner's in-process connection holder. */
    readonly holder: Holder
    /** Ends the actor's activation on this runner as idle expiry would. */
    readonly hibernate: (ref: ActorRef) => Effect.Effect<void>
    readonly execute: (request: Request) => Effect.Effect<Outcome, ActorError>
    /**
     * Delivers a committed intent. The obligation was admitted by its sending
     * turn, so external access and command-id expiry are not checked again.
     */
    readonly deliver: (request: Request) => Effect.Effect<Outcome, ActorError>
    /** Runs relay passes until no due intent remains; used by `ActorTest.advance`. */
    readonly drainOutbox: Effect.Effect<void>
    /** Runs one retention sweep now; used by `ActorTest.cleanup`. */
    readonly cleanup: Effect.Effect<Swept>
    /**
     * Moves the leases of this runner's running effect attempts forward and
     * runs `jump`, with no relay pass between them; used by `ActorTest.advance`.
     */
    readonly extendOutboxLeases: (millis: number, jump: Effect.Effect<void>) => Effect.Effect<void>
    readonly registerQueries: (actor: QueryRegistration) => Effect.Effect<void, never, Scope.Scope>
    readonly registerEffects: (actor: EffectRegistration) => Effect.Effect<void, never, Scope.Scope>
    readonly query: (request: Request) => Effect.Effect<Outcome, ActorError>
    /** Whether the actor has a generation row, read without waking or creating it. */
    readonly exists: (ref: ActorRef) => Effect.Effect<boolean, ActorError>
    /**
     * Reads up to `limit` committed events of `tags` after an exclusive
     * cursor, like a query, without waking the actor; an actor with no
     * generation row fails `NotCreated` and gets none.
     */
    readonly readFeed: (
      ref: ActorRef,
      tags: ReadonlyArray<string>,
      after: string | undefined,
      limit: number,
    ) => Effect.Effect<
      ReadonlyArray<StoredEvent & { readonly tag: string }>,
      ActorError | UnknownCursor | RetentionGap
    >
    /**
     * Subscribes to a stream member on the actor's owner: `request.command`
     * is the member and `request.payload` its encoded input. Elements arrive
     * encoded; a declared failure fails with its encoding.
     */
    readonly subscribe: (
      request: Request,
    ) => Stream.Stream<string, ActorError | { readonly failure: string }>
    /**
     * Reads one execution's status like a query: `request.command` is the
     * workflow member, `request.payload` the execution id.
     */
    readonly pollWorkflow: (
      request: Request,
    ) => Effect.Effect<WorkflowStatus | undefined, ActorError>
    readonly mintActorId: Effect.Effect<string>
    /** Derives the id a parent turn mints for a child actor. */
    readonly mintChildId: (input: MintInput) => Effect.Effect<string>
    /** The deployment's command retry window: every id's `expiresAt - issuedAt`. */
    readonly retryWindowMs: number
    /** The database clock in epoch milliseconds, the only clock command ids are checked against. */
    readonly databaseNow: Effect.Effect<number, ActorError>
    /** A fresh command id issued at the database clock, as `Actors.mintCommandId` returns. */
    readonly mintCommandId: Effect.Effect<string, ActorError>
    /**
     * Binds owned-table capabilities to the calling fiber's turn or query.
     * Writable access requires the turn transaction and never opens its own.
     */
    readonly tables: (scope: TableScope, write: boolean) => Effect.Effect<TableAccess>
    /** The Cluster shard that places `ref`'s activation, as stored in runner shard locks. */
    readonly shardId: (ref: ActorRef) => Effect.Effect<string>
    /** Binds blob capabilities the same way; writable access requires the turn transaction. */
    readonly blobs: (scope: BlobScope, write: boolean) => Effect.Effect<BlobAccess>
    /** Which layers of an actor type this process registered. */
    readonly registered: (actor: string) => {
      readonly commands: boolean
      readonly queries: boolean
    }
    /** The blob names a registered actor type declares, for test inspection. */
    readonly declaredBlobs: (actor: string) => ReadonlyArray<string>
  }
>()("@durable-actors/core/handles/actors/InternalActors") {}

export class Actors extends Context.Service<
  Actors,
  {
    /** Mints a command id for `Actor.commandId`, so a caller can retry one operation across processes. */
    readonly mintCommandId: Effect.Effect<string>
  }
>()("@durable-actors/core/handles/actors") {}
