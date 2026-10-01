import { Schema } from "effect"
import { ClusterSchema, Entity, type EntityId } from "effect/cluster"
import { Rpc } from "effect/rpc"
import { ActorError, SessionEnded } from "../../errors/actor.ts"
import { ActorRef, Caller } from "../../identity/caller.ts"

/**
 * The framework connection member an event feed opens. It has no handler, and
 * `$` can't start a declared member's tag, so it never collides with one.
 */
export const FEED_MEMBER = "$feed"

/** The prefix of the framework connection member a query watch opens; the watched query's tag follows. */
export const WATCH_PREFIX = "$watch:"

/** The framework connection member that watches `query`. `$` can't start a declared member's tag, so it never collides with one. */
export const watchMember = (query: string) => `${WATCH_PREFIX}${query}`

/** Whether `member` is a framework watch connection. */
export const isWatchMember = (member: string) => member.startsWith(WATCH_PREFIX)

/** The query a framework watch member watches. */
export const watchedQuery = (member: string) => member.slice(WATCH_PREFIX.length)

/** What one commit wrote: whether it changed state, and the event classes, tables, and blobs it wrote. */
export const WriteSet = Schema.Struct({
  state: Schema.Boolean,
  events: Schema.Array(Schema.String),
  tables: Schema.Array(Schema.String),
  blobs: Schema.Array(Schema.String),
})

/** What one commit wrote. */
export type WriteSet = typeof WriteSet.Type

/** The frame an owner broadcasts to an actor's watches after each commit: the commit's version and its write set. */
export const Committed = Schema.Struct({ version: Schema.String, writes: WriteSet })

/** A decoded `Committed` frame. */
export type Committed = typeof Committed.Type

/** One committed feed event as its owner broadcasts it; `value` is the stored encoding. */
export const FeedFrame = Schema.Struct({
  tag: Schema.String,
  value: Schema.String,
  commandId: Schema.String,
  timestampMs: Schema.Finite,
})

/** A committed feed event as a holder receives it. */
export type FeedFrame = typeof FeedFrame.Type

/** What an owner sends a holder over its ordered channel. */
export const HolderItem = Schema.TaggedUnion({
  Frame: {
    member: Schema.String,
    to: Schema.Array(Schema.String),
    frame: Schema.String,
    event: Schema.optional(Schema.String),
    stamp: Schema.Boolean,
    replay: Schema.optional(Schema.Boolean),
  },
  Flushed: { through: Schema.String },
  End: { connectionId: Schema.String, ended: SessionEnded },
  Seal: {},
  /** Executor progress: replaces an undelivered frame of the same job, never closes a session. */
  Progress: {
    member: Schema.String,
    to: Schema.Array(Schema.String),
    job: Schema.String,
    jobId: Schema.String,
    attempt: Schema.Finite,
    seq: Schema.Finite,
    frame: Schema.String,
  },
  /** The job's route or settle committed: undelivered progress of it is discarded. */
  ProgressEnd: { jobId: Schema.String },
})

/** One item of an ordered owner-to-holder message. */
export type HolderItem = typeof HolderItem.Type

/** What a client of an open connection receives. */
export const ClientMessage = Schema.TaggedUnion({
  Frame: {
    frame: Schema.String,
    cursor: Schema.optional(Schema.String),
    event: Schema.optional(Schema.String),
  },
  Resync: {
    after: Schema.UndefinedOr(Schema.String),
    reason: Schema.Literal("OwnerLost"),
    deadlineMs: Schema.Finite,
  },
  ResyncReplayed: {},
  Progress: {
    job: Schema.String,
    jobId: Schema.String,
    attempt: Schema.Finite,
    seq: Schema.Finite,
    frame: Schema.String,
  },
})

/** A message a client of an open connection receives. */
export type ClientMessage = typeof ClientMessage.Type

/** One ordered owner message to a holder: `seq` numbers it within its generation and `through` is the owner position it covers. */
export const Deliver = Schema.Struct({
  epoch: Schema.String,
  owner: Schema.String,
  ownerEpoch: Schema.String,
  ref: ActorRef,
  generation: Schema.String,
  seq: Schema.Finite,
  through: Schema.String,
  items: Schema.Array(HolderItem),
})

/** A decoded `Deliver`. */
export type Deliver = typeof Deliver.Type

/** A holder's acknowledgment: `wrongEpoch` when it is not the holder the owner addressed, and the ids of addressed connections it does not hold. */
export const Delivered = Schema.Struct({
  wrongEpoch: Schema.Boolean,
  unknown: Schema.Array(Schema.String),
})

/** A decoded `Delivered`. */
export type Delivered = typeof Delivered.Type

const HOLDER_SEPARATOR = "|"

/**
 * A runner's holder shard group, which only that runner is assigned. Cluster
 * stores shard ids in 50 characters, so the group is a hash of the address.
 */
export const holderGroup = (address: { readonly host: string; readonly port: number }) =>
  `h${BigInt.asUintN(64, Bun.hash.xxHash3(`${address.host}:${address.port}`)).toString(36)}`

/** The entity id addressing one holder incarnation, from its runner identity and epoch. */
export const holderEntityId = (address: { readonly holder: string; readonly epoch: string }) =>
  `${address.holder}${HOLDER_SEPARATOR}${address.epoch}`

/** The framework entity through which owners on other runners reach this runner's holder. */
export const HolderEntity = Entity.make("durable-actors/Holder", [
  Rpc.make("Deliver", { payload: Deliver, success: Delivered }),
  Rpc.make("Ping", { payload: { epoch: Schema.String }, success: Schema.Boolean }),
]).annotate(
  ClusterSchema.ShardGroup,
  (entityId: EntityId.EntityId) => entityId.split(HOLDER_SEPARATOR)[0]!,
)

/** The fields that locate one connection: its actor, id, holder, and holder epoch. */
export const ConnectionAddress = {
  ref: ActorRef,
  connectionId: Schema.String,
  holder: Schema.String,
  holderEpoch: Schema.String,
}

const Commands = Schema.Struct({
  secret: Schema.String,
  seq: Schema.Finite,
  issuedAt: Schema.Finite,
  expiresAt: Schema.Finite,
})

/** The activation that answered: its fencing generation and its runner's holder identity. */
const OwnerIdentity = {
  generation: Schema.String,
  owner: Schema.String,
  ownerEpoch: Schema.String,
}

/** The owner's answer to an open: the baseline it fixed, or the handler's declared failure. */
export const Opened = Schema.TaggedUnion({
  Opened: { ...OwnerIdentity, baseline: Schema.String, recovered: Schema.optional(Schema.Boolean) },
  Failed: { value: Schema.String },
})

/** The owner's answer to an acknowledgment: accepted, or the session ended. */
export const Acked = Schema.TaggedUnion({
  Acked: OwnerIdentity,
  Closed: { ended: SessionEnded },
})

/** The owner's answer to a finished resync replay: accepted, or the session ended. */
export const Replayed = Schema.TaggedUnion({
  Replayed: OwnerIdentity,
  Closed: { ended: SessionEnded },
})

/** What a stream subscription receives from the owner, after which the owner's errors follow. */
export const StreamItem = Schema.TaggedUnion({
  /** The activation that runs the handler; a second one means the request was sent again. */
  Started: { owner: Schema.String, ownerEpoch: Schema.String },
  Element: { value: Schema.String },
  /** The handler's stream ended by itself. */
  Done: {},
})

/** A decoded `StreamItem`. */
export type StreamItem = typeof StreamItem.Type

/** A stream handler's declared failure, encoded. */
export const StreamFailed = Schema.TaggedStruct("StreamFailed", { value: Schema.String })

/**
 * Messages a holder or a stream subscriber sends an actor's owner; they
 * bypass the command mailbox. A subscription is interruptible, so a
 * subscriber that stops ends the handler on the owner.
 */
export const connectionsEntity = (name: string) =>
  Entity.make(`${name}/Connections`, [
    Rpc.make("Open", {
      payload: {
        ...ConnectionAddress,
        member: Schema.String,
        caller: Caller,
        params: Schema.String,
        commands: Commands,
      },
      success: Opened,
      error: ActorError,
    }).annotate(ClusterSchema.Uninterruptible, true),
    Rpc.make("Frame", {
      payload: {
        ...ConnectionAddress,
        seq: Schema.Finite,
        frame: Schema.String,
        authorizedUntil: Schema.Finite,
        commands: Commands,
      },
      success: Acked,
      error: ActorError,
    }).annotate(ClusterSchema.Uninterruptible, true),
    Rpc.make("Close", {
      payload: { ...ConnectionAddress, cause: SessionEnded },
      error: ActorError,
    }).annotate(ClusterSchema.Uninterruptible, true),
    Rpc.make("Resync", {
      payload: {
        ...ConnectionAddress,
        after: Schema.optional(Schema.String),
        authorizedUntil: Schema.Finite,
      },
      success: Replayed,
      error: ActorError,
    }).annotate(ClusterSchema.Uninterruptible, true),
    Rpc.make("Progress", {
      payload: {
        ref: ActorRef,
        jobId: Schema.String,
        job: Schema.String,
        attempt: Schema.Finite,
        seq: Schema.Finite,
        leaseUntil: Schema.Finite,
        frame: Schema.String,
      },
    }).annotate(ClusterSchema.Uninterruptible, true),
    Rpc.make("ProgressClosed", {
      payload: { ref: ActorRef, jobId: Schema.String, attempt: Schema.Finite },
    }).annotate(ClusterSchema.Uninterruptible, true),
    Rpc.make("Subscribe", {
      payload: {
        member: Schema.String,
        caller: Caller,
        input: Schema.String,
        authorizedUntil: Schema.Finite,
      },
      success: StreamItem,
      error: Schema.Union([ActorError, StreamFailed]),
      stream: true,
    }),
  ])
