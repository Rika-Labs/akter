import { Effect, Match, Option, Predicate, Queue, Schema, Stream } from "effect"
import type { ActorError } from "../../errors/actor.ts"
import { RetentionGap, UnknownCursor } from "../../errors/events.ts"
import type { InternalActors } from "../../handles/actors.ts"
import type { ActorRef, Caller } from "../../identity/caller.ts"
import type { HeldConnection } from "../../runtime/connections/holder.ts"
import { FEED_MEMBER, FeedFrame } from "../../runtime/connections/protocol.ts"
import { actorErrorBody } from "../wire.ts"

/** Events a feed reads from `actor_events` per statement. */
const FEED_PAGE = 256

/** At most this many `event` filters per feed. */
export const MAX_FEED_FILTERS = 16

/** A comment line this often keeps idle proxies from closing the stream. */
export const FEED_KEEPALIVE_MS = 15_000

const decodeFeedFrame = Schema.decodeEffect(Schema.fromJsonString(FeedFrame))

const decodeStored = Schema.decodeEffect(Schema.fromJsonString(Schema.Json))

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const encodeCursorError = Schema.encodeEffect(Schema.Union([UnknownCursor, RetentionGap]))

/** The JSON body a cursor error is served as, before a stream starts or as a feed's last message. */
export const cursorErrorBody = (error: UnknownCursor | RetentionGap) =>
  encodeCursorError(error).pipe(Effect.orDie)

/** One feed event as its SSE message's `data` carries it. */
const FeedData = Schema.Struct({
  event: Schema.Json,
  commandId: Schema.String,
  timestamp: Schema.Finite,
})

const encodeData = Schema.encodeEffect(Schema.fromJsonString(FeedData))

type FeedEvent = {
  readonly cursor: string
  readonly tag: string
  readonly value: string
  readonly commandId: string
  readonly timestampMs: number
}

/** An SSE message: one event, identified by its cursor so `Last-Event-ID` resumes after it. */
const message = (event: FeedEvent) =>
  Effect.gen(function* () {
    const data = yield* encodeData({
      event: yield* decodeStored(event.value),
      commandId: event.commandId,
      timestamp: event.timestampMs,
    })

    return `id: ${event.cursor}\nevent: ${event.tag}\ndata: ${data}\n\n`
  }).pipe(Effect.orDie)

/** The feed's last message: the error that ended it, as a served response body would carry it. */
const endMessage = (error: ActorError | UnknownCursor | RetentionGap) =>
  Effect.gen(function* () {
    const body = Predicate.isTagged(error, "ActorError")
      ? yield* actorErrorBody(error)
      : yield* cursorErrorBody(error)

    return `event: end\ndata: ${yield* encodeJson(body).pipe(Effect.orDie)}\n\n`
  })

/** Ends that a feed survives by reopening at its holder and rereading from its cursor. */
const recoverable = (error: ActorError) =>
  Predicate.isTagged(error.reason, "SessionEnded") &&
  ["SlowConsumer", "OwnerLost", "ActorUnavailable"].includes(error.reason.cause)

/** What a feed reads and who reads it. */
export interface FeedOptions {
  readonly actors: InternalActors["Service"]
  /** The actor whose committed events the feed serves. */
  readonly ref: ActorRef
  /** The event tags the feed serves; the holder authorizes each one. */
  readonly tags: ReadonlyArray<string>
  readonly caller: Caller
  /** The credential's expiry in epoch milliseconds, which ends the feed. */
  readonly expiresAt: number | undefined
}

/**
 * Opens a feed at this runner's holder: the framework feed member, authorized
 * per event tag, whose row makes the owner broadcast every committed feed
 * event. The actor must already exist; a feed never creates one.
 */
export const openFeed = (options: FeedOptions) =>
  options.actors.holder
    .open({
      ref: options.ref,
      member: FEED_MEMBER,
      caller: options.caller,
      params: "",
      expiresAt: options.expiresAt,
      feed: options.tags,
    })
    .pipe(
      Effect.catchTag("OpenRejected", () => Effect.die(new Error("A feed has no open handler"))),
    )

/**
 * The events of a feed after `after`, as SSE text: first the committed events
 * read from `actor_events`, then live ones from the holder, deduplicated by
 * cursor so the race between the two neither loses nor repeats one. After an
 * owner loss, a gap, or a full buffer, the feed rereads from the last cursor
 * it sent instead of ending, so a client sees one gap-free stream; any other
 * end is its last message. The `actor_events` table is the source of truth: the
 * holder resyncs a feed itself, and once the new owner answers the feed rereads
 * and goes on. A feed lists no effect, so the owner never sends it progress. A
 * comment line every `FEED_KEEPALIVE_MS` keeps idle proxies from closing the
 * stream.
 */
export const feedStream = ({
  options,
  first,
  after,
}: {
  readonly options: FeedOptions
  /** The feed the caller opened before its first read, so no commit falls between them. */
  readonly first: HeldConnection
  readonly after: string | undefined
}) =>
  Stream.callback<string>((out) =>
    Effect.gen(function* () {
      const wanted = new Set(options.tags)
      let last = BigInt(after ?? "0")
      let held = first

      yield* Effect.addFinalizer(() => held.close)

      const emit = (event: FeedEvent) =>
        Effect.gen(function* () {
          if (BigInt(event.cursor) <= last) return
          last = BigInt(event.cursor)
          yield* Queue.offer(out, yield* message(event))
        })

      const catchUp = Effect.gen(function* () {
        while (true) {
          const page = yield* options.actors.readFeed(
            options.ref,
            options.tags,
            String(last),
            FEED_PAGE,
          )

          for (const event of page) yield* emit(event)

          if (page.length < FEED_PAGE) return
        }
      })

      const live = (connection: HeldConnection) =>
        connection.messages.pipe(
          Stream.runForEach((item) =>
            Match.value(item).pipe(
              Match.tagsExhaustive({
                Frame: (frame) =>
                  frame.event === undefined
                    ? Effect.void
                    : decodeFeedFrame(frame.frame).pipe(
                        Effect.orDie,
                        Effect.flatMap((decoded) =>
                          wanted.has(decoded.tag)
                            ? emit({ ...decoded, cursor: frame.event! })
                            : Effect.void,
                        ),
                      ),
                Resync: () => Effect.void,
                ResyncReplayed: () => catchUp.pipe(Effect.andThen(connection.resyncDone)),
                Progress: () => Effect.void,
              }),
            ),
          ),
        )

      const run: Effect.Effect<void, ActorError | UnknownCursor | RetentionGap> = Effect.gen(
        function* () {
          while (true) {
            yield* catchUp
            const ended = yield* live(held).pipe(Effect.flip, Effect.option)

            if (Option.isNone(ended)) return

            if (!Predicate.isTagged(ended.value, "ActorError") || !recoverable(ended.value))
              return yield* ended.value

            held = yield* openFeed(options)
          }
        },
      )

      yield* run.pipe(
        Effect.catch((error) =>
          endMessage(error).pipe(Effect.flatMap((text) => Queue.offer(out, text))),
        ),
        Effect.andThen(Queue.end(out)),
        Effect.forkScoped,
      )
    }),
  ).pipe(
    Stream.merge(
      Stream.tick(FEED_KEEPALIVE_MS).pipe(
        Stream.drop(1),
        Stream.map(() => ": keepalive\n\n"),
      ),
      { haltStrategy: "left" },
    ),
    Stream.encodeText,
  )
