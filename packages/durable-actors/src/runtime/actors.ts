import { Context, type Effect, type Scope, type Stream } from "effect"
import type { Transport } from "./connections/transport.ts"
import type { Holder } from "./connections/holder.ts"
import type { ProgressMessage } from "./effects/progress.ts"
import type { ActorError } from "../errors/actor.ts"
import type { RetentionGap, UnknownCursor } from "../errors/events.ts"
import type { ActorRef, Caller } from "../identity/caller.ts"
import type { Seed } from "./operators/seed.ts"
import type { MintInput } from "../identity/mint.ts"
import type { Swept } from "./storage/retention.ts"
import type { BlobAccess, BlobScope } from "../state/blob.ts"
import type { TableAccess, TableScope } from "../tables/owned.ts"
import type { Executed, Outcome, Request } from "./request.ts"
import type {
  EffectRegistration,
  QueryRegistration,
  Registration,
  StoredEvent,
  WorkflowStatus,
} from "./members.ts"

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
    readonly execute: (request: Request) => Effect.Effect<Executed, ActorError>
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
     * Sweeps every tenant's unreferenced content now, whenever each was last
     * swept, and returns how many contents it deleted; for tests.
     */
    readonly sweepContent: Effect.Effect<number>
    /**
     * Moves the leases of this runner's running effect attempts forward and
     * runs `jump`, with no relay pass between them; used by `ActorTest.advance`.
     */
    readonly extendOutboxLeases: (millis: number, jump: Effect.Effect<void>) => Effect.Effect<void>
    readonly registerQueries: (actor: QueryRegistration) => Effect.Effect<void, never, Scope.Scope>
    readonly registerEffects: (actor: EffectRegistration) => Effect.Effect<void, never, Scope.Scope>
    /**
     * Reads committed state. With `minVersion`, a configured replica answers
     * only once it has replayed that commit version; otherwise the primary does.
     */
    readonly query: (request: Request, minVersion?: string) => Effect.Effect<Outcome, ActorError>
    /** The highest commit version any command sent through this runtime has returned. */
    readonly observedVersion: () => string | undefined
    /** Sends one progress message to its actor's owner as an executor pool would; for tests. */
    readonly deliverProgress: (message: ProgressMessage) => Effect.Effect<void>
    /** Whether the actor has a generation row, read without waking or creating it. */
    readonly exists: (ref: ActorRef) => Effect.Effect<boolean, ActorError>
    /**
     * Reads up to `limit` committed events of `tags` after an exclusive
     * cursor, like a query, without waking the actor; an actor with no
     * generation row fails `NotCreated` and gets none. Values are upcast to
     * the current version of their class.
     */
    readonly readFeed: (
      ref: ActorRef,
      tags: ReadonlyArray<string>,
      after: string | undefined,
      limit: number,
    ) => Effect.Effect<
      ReadonlyArray<Omit<StoredEvent, "version"> & { readonly tag: string }>,
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
    /**
     * Starts the actor `ref` from `seed` in one transaction, staging its
     * pending work as `caller`; dies, writing nothing, when the seed is of
     * another type, names an effect the actor does not register, or the
     * actor already exists.
     */
    readonly seed: (request: {
      readonly ref: ActorRef
      readonly caller: Caller
      readonly seed: Seed
    }) => Effect.Effect<void>
  }
>()("@durable-actors/core/runtime/actors/InternalActors") {}
