import {
  type Context,
  type Effect,
  type Exit,
  type Option,
  Schema,
  type Scope,
  type Stream,
} from "effect"
import type { Access } from "../policies/access.ts"
import type { SubscriptionFailure } from "../errors/subscription.ts"
import type { RetentionGap, UnknownCursor } from "../errors/events.ts"
import type { ActorRef, Caller, Principal } from "../identity/caller.ts"
import type { Placement } from "./storage/codec.ts"
import type { ConnectionCommands } from "../identity/connection.ts"
import type { TurnPolicy } from "../policies/command.ts"
import type { CronEntry } from "./cron/schedule.ts"
import type { StagedOutbox } from "../handles/intents.ts"
import type { AnyBlob } from "../members/blob.ts"
import type { AnyOwnedTable } from "../tables/owned.ts"
import type { RecordedExit, StoredResult, WorkflowContext } from "../contexts/workflow.ts"
import type { ReadSet } from "./connections/reads.ts"
import type { AnyWorkflow } from "../members/workflow.ts"
import type { PayloadDeclaration } from "../members/payload.ts"
import type { Outcome, Request } from "./request.ts"

/** What a command handler leaves for the turn to commit: its outcome, the state to store, and the events, intents, and frames it staged. */
export interface BusinessResult {
  readonly outcome: Outcome
  readonly state: ReadonlyArray<readonly [string, string]>
  /** `state` lists every stored key; the turn deletes any other stored key. */
  readonly complete: boolean
  /** Encoded events in emit order, appended with the commit. */
  readonly events: ReadonlyArray<EmittedEvent>
  /** Intents and jobs to commit with the turn; a declared failure stages none. */
  readonly outbox: StagedOutbox
  /** Frames to send to open connections once the turn commits; a declared failure sends none. */
  readonly broadcasts?: ReadonlyArray<Broadcast>
  /** The declared tables and blobs the turn wrote; a declared failure wrote none. */
  readonly writes?: {
    readonly tables: ReadonlyArray<string>
    readonly blobs: ReadonlyArray<string>
  }
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

/** One event a turn emitted, encoded for the append. */
export interface EmittedEvent {
  readonly tag: string
  readonly value: string
  /** The payload version `value` is encoded at. */
  readonly version: number
}

/** One committed event as the log returns it. */
export interface StoredEvent {
  readonly cursor: string
  readonly commandId: string
  readonly value: string
  /** The payload version `value` was written at; readers upcast it through the class's chain. */
  readonly version: number
  readonly timestampMs: number
}

/** Reads one actor's committed events of one tag after an exclusive cursor, up to the query's snapshot. */
export type EventReader = (
  tag: string,
  after: string | undefined,
  limit: number,
) => Effect.Effect<ReadonlyArray<StoredEvent>, UnknownCursor | RetentionGap>

/** A command bound to its handler when the actor's layer was built. */
export interface RegisteredCommand {
  readonly internal: boolean
  /** Named as a subscription's handler: only subscription deliveries reach it. */
  readonly handler: boolean
  readonly run: (
    request: Request,
    state: ReadonlyArray<readonly [string, string]>,
    turn: {
      /** The actor's event sequence before this turn's emits. */
      readonly head: string
      readonly connections?: ConnectionLister | undefined
    },
  ) => Effect.Effect<BusinessResult, BusinessResult>
  /**
   * A commutative reducer's merged turn: the inputs of `requests`, combined
   * in order, reduced once. Every request's outcome is the one `outcome`, and
   * the merge law makes the state equal to applying them one at a time.
   */
  readonly merge?: (
    requests: ReadonlyArray<Request>,
    state: ReadonlyArray<readonly [string, string]>,
  ) => Effect.Effect<BusinessResult>
}

/** What one connection handler is asked to do. */
export const ConnectionPhase = Schema.TaggedUnion({
  Open: { params: Schema.String },
  Frame: { frame: Schema.String },
  Close: { reason: Schema.String },
  Resync: { after: Schema.UndefinedOr(Schema.String) },
})

/** One connection handler phase. */
export type ConnectionPhase = typeof ConnectionPhase.Type

/** The committed view and capabilities one connection handler runs with. */
interface ConnectionInput {
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

/** A connection member bound to its handler. */
export interface RegisteredConnection {
  readonly stampCursor: boolean
  /** Effect tags whose progress this member receives, and its audience. */
  readonly progress:
    | { readonly effects: ReadonlySet<string>; readonly to: "performer" | "all" }
    | undefined
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
  /** Accepted progress of one effect tag from now on; empty for a tag the member does not list. */
  readonly progress: (tag: string, effectId: string | undefined) => Stream.Stream<StoredProgress>
}

/** One accepted progress frame, still encoded. */
export interface StoredProgress {
  readonly effectId: string
  /** The effect's encoded input, as performed. */
  readonly effect: string
  readonly attempt: number
  readonly seq: number
  /** The frame, JSON-encoded under the effect's progress schema. */
  readonly frame: string
}

/** A stream member bound to its handler. */
export interface RegisteredStream {
  /** Effect tags whose progress the handler may read. */
  readonly progress: ReadonlySet<string>
  /** Encoded elements; a declared failure is encoded, anything else is a defect. */
  readonly run: (
    payload: string,
    input: StreamInput,
  ) => Stream.Stream<string, { readonly failure: string }>
}

/** A command a job's outcome is delivered to, with its encoded input. */
export interface JobRoute {
  readonly command: string
  readonly payload: string
}

/** How one executor attempt ended without a result. */
export interface JobFailure {
  readonly cause: string
  /** True when the provider may have applied the call anyway. */
  readonly ambiguous: boolean
  /** Retrying cannot help, so the job is dead-lettered now. */
  readonly final?: boolean
  /**
   * The executor never ran, as when the stored payload does not decode, so
   * this attempt applied nothing and the row keeps what earlier attempts may
   * have applied; `ambiguous` is ignored.
   */
  readonly notStarted?: boolean
}

/** What the relay gives one attempt; the executor sees it as `X.Executor`. */
export interface AttemptContext {
  /** Stable across every attempt of the job. */
  readonly jobId: string
  /** 1 on the first attempt. */
  readonly attempt: number
  /** The principal of the turn that enqueued the job. */
  readonly principal: Option.Option<Principal>
  /** The actor that enqueued the job. */
  readonly ref: ActorRef
  /** False when progress reports go nowhere, so frames need not be encoded. */
  readonly reporting: () => boolean
  /** Offers one encoded progress frame to the attempt's slot. */
  readonly report: (frame: Uint8Array) => Effect.Effect<void>
}

/** What a settled job reports to its `onCancelled` or `onDeadLetter` route. */
export interface JobLetter {
  readonly jobId: string
  readonly attempts: number
  readonly ambiguous: boolean
}

/** A job class bound to its executor and retry policy. */
export interface RegisteredJob {
  /** Total attempts before the job is dead-lettered. */
  readonly attempts: number
  /** The least time between two progress frames of one attempt; undefined when the job declares no progress. */
  readonly progressEveryMs: number | undefined
  /** The wait after failed attempt `n` is `min(baseMs × 2^(n − 1), maxMs)`. */
  readonly backoff: { readonly baseMs: number; readonly maxMs: number }
  /** Attempts running at once per actor across runners; unlimited when undefined. */
  readonly perActor: number | undefined
  /** Whether the job declares an `onCancelled` route. */
  readonly routesCancelled: boolean
  /**
   * Runs one attempt; succeeds with the `onSuccess` route and the
   * `onCancelled` route of its result, each if declared, or with the reason
   * `onSuccess` rejects the result.
   */
  readonly execute: (
    payload: string,
    version: number,
    context: AttemptContext,
  ) => Effect.Effect<
    {
      readonly success: JobRoute | undefined
      readonly cancelled: JobRoute | undefined
      /** Why `onSuccess` cannot accept the result, when it cannot. */
      readonly rejected: JobFailure | undefined
    },
    JobFailure
  >
  /** The `onCancelled` route for a cancelled job without a result, if declared. */
  readonly cancelled: (
    payload: string,
    version: number,
    letter: JobLetter & {
      readonly outcome: { readonly _tag: "Failed" | "Unknown"; readonly cause: string }
    },
  ) => Effect.Effect<JobRoute | undefined>
  /** The `onDeadLetter` route for an exhausted job, if declared. */
  readonly deadLetter: (
    payload: string,
    version: number,
    letter: JobLetter & { readonly cause: string },
  ) => Effect.Effect<JobRoute | undefined>
}

/** What an actor type's job layer registers with the runtime. */
export interface JobRegistration {
  readonly name: string
  /** Job tags some connection or stream member of the actor receives progress of. */
  readonly progress: ReadonlySet<string>
  /** The job layer's build context; executor attempts run in it. */
  readonly services: Context.Context<never>
  readonly jobs: ReadonlyMap<string, RegisteredJob>
  /** The job classes the layer reads, for the startup payload check. */
  readonly payloads: ReadonlyArray<PayloadDeclaration>
}

/** One result of a watch: the query's encoded output, and the commit version its rerun waited for when there was one. */
export interface WatchResult {
  readonly version: string | undefined
  readonly value: string
}

/** A query reads committed state; it never activates, fences, or receipts. */
export interface RegisteredQuery {
  /** Whether the member is declared `watch: true`, so its handler needs nothing but `X.Read`. */
  readonly watch: boolean
  /** With `reads`, the handler runs on a recording `X.Read` and fills `reads`, and no service but `X.Read` is provided. */
  readonly run: (
    request: Request,
    state: ReadonlyArray<readonly [string, string]>,
    cursor: string,
    events: EventReader,
    reads?: ReadSet,
  ) => Effect.Effect<Outcome>
}

/** What an actor type's query layer registers with the runtime. */
export interface QueryRegistration {
  readonly name: string
  readonly placement: Placement
  /** `commandTimeout`: a query's reads are cancelled on the server past it. */
  readonly timeoutMs: number
  readonly tables: ReadonlyArray<AnyOwnedTable>
  readonly blobs: ReadonlyArray<AnyBlob>
  readonly queries: ReadonlyMap<string, RegisteredQuery>
  /** The actor's `access` policy; undefined when it declares none. */
  readonly access: Access | undefined
  /** The event classes the layer reads, for the startup payload check. */
  readonly payloads: ReadonlyArray<PayloadDeclaration>
}

/** What an actor type's command layer registers with the runtime. */
export interface Registration {
  readonly name: string
  readonly singleton: boolean
  /** Unkeyed with `policy.createdBy`: its UUIDv8 ids come only from `turn.mint`. */
  readonly mintable: boolean
  /** The deployment's default tenant: the ambient `Tenant` when the actor's layer is built. */
  readonly tenant: string
  /** The actor's `access` policy; undefined when it declares none. */
  readonly access: Access | undefined
  readonly placement: Placement
  readonly policy: TurnPolicy
  readonly tables: ReadonlyArray<AnyOwnedTable>
  readonly blobs: ReadonlyArray<AnyBlob>
  /**
   * Resolves one activation's commands in the activation's scope. A singleton
   * runs its build here, so fibers it forks live as long as the activation,
   * and a build failure defects that activation rather than failing its layer.
   */
  readonly activate: (
    ref: ActorRef,
  ) => Effect.Effect<ReadonlyMap<string, RegisteredCommand>, never, Scope.Scope>
  readonly connections: ReadonlyMap<string, RegisteredConnection>
  readonly streams: ReadonlyMap<string, RegisteredStream>
  /** Tags of the events this actor type serves as event feeds. */
  readonly feeds: ReadonlySet<string>
  /** Tags of the queries declared `watch: true`. */
  readonly watches: ReadonlySet<string>
  /** Workflow members with their bodies, keyed by tag. */
  readonly workflows: ReadonlyMap<string, RegisteredWorkflow>
  /** `policy.cron` entries; each is one keyed tick row per actor. */
  readonly cron: ReadonlyArray<CronEntry>
  /** The subscriptions this actor type declares, as its subscriber. */
  readonly subscriptions: ReadonlyArray<RegisteredSubscription>
  /** `policy.subscribers` of this actor type as a source; undefined allows every type. */
  readonly subscribers: ReadonlyArray<string> | undefined
  /**
   * Every event and job class the layer writes or reads, its
   * subscriptions' source events included, for the startup payload check.
   */
  readonly payloads: ReadonlyArray<PayloadDeclaration>
  /**
   * A stored event of this type as the current class encodes it; a value
   * the chain cannot read is a defect. Unchanged at the current version.
   */
  readonly upcastEvent: (tag: string, version: number, value: string) => Effect.Effect<string>
}

/** One `Actor.subscription` of a registered subscriber type. */
export interface RegisteredSubscription {
  readonly tag: string
  readonly sourceType: string
  /** The internal command deliveries run. */
  readonly handler: string
  /** Event tags this declaration delivers. */
  readonly events: ReadonlyArray<string>
  /** Event tags it once delivered; rows carrying them stay claimable and skip them. */
  readonly retired: ReadonlyArray<string>
  /** How a routed subscription names its subscriber; undefined for a dynamic one. */
  readonly routed: "id" | "singleton" | undefined
  /**
   * The subscriber id of one event of a routed subscription: decodes the
   * stored event, applies `route`, and checks the id against the subscriber's
   * key schema. Fails when any step fails.
   */
  readonly route: (
    tag: string,
    value: string,
    source: ActorRef,
  ) => Effect.Effect<string, SubscriptionFailure>
  /**
   * A stored source event as the subscriber's class encodes it; fails when
   * the chain cannot read it, so the delivery backs off instead of skipping.
   */
  readonly upcast: (
    tag: string,
    version: number,
    value: string,
  ) => Effect.Effect<string, SubscriptionFailure>
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
