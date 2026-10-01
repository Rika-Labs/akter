import { Effect, type Option, Schema, Stream } from "effect"
import type { ActorError } from "../../errors/actor.ts"
import { RetentionGap, UnknownCursor } from "../../errors/events.ts"
import type { EventClass } from "../../members/event.ts"
import { decodeFailure, type Failure, undecodableFailure } from "../transport.ts"
import { IDLE_MS, readEvents, reconnecting, session } from "./sse.ts"

/** One committed event a feed delivered, with the cursor to resume after it. */
export interface FeedEntry<E> {
  /** Exclusive resume point: pass it as `after` to read the events that follow. */
  readonly cursor: string
  /** The decoded event. */
  readonly event: E
  /** The id of the command that committed the event. */
  readonly commandId: string
  /** When the event committed, in milliseconds since the epoch. */
  readonly timestamp: number
}

/** Options of one event feed iteration. */
export interface FeedOptions {
  /** Resume after this cursor; omitted, the feed starts at the actor's first retained event. */
  readonly after?: string
  /** Ends the iteration; the feed stops at once. */
  readonly signal?: AbortSignal
}

const decodeData = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ event: Schema.Json, commandId: Schema.String, timestamp: Schema.Finite }),
  ),
)

const cursorError: (body: Schema.Json) => Option.Option<Failure> = Schema.decodeUnknownOption(
  Schema.toCodecJson(Schema.Union([UnknownCursor, RetentionGap])),
)

/** A refusal's body, with its response's headers so a `Retry-After` is kept; an `end` message has none. */
const failureOf = (text: string, status: number, headers = new Headers()) =>
  decodeFailure(cursorError)({ status, headers, text, sentAt: 0 })

interface FeedSource<E extends EventClass> {
  /** Fetches the feed after `cursor`, sent as `Last-Event-ID`, with fresh headers each time. */
  readonly open: (
    cursor: string | undefined,
    signal: AbortSignal,
  ) => Effect.Effect<Response, ActorError>
  /** The event class the feed delivers; its identifier is the tag asked for. */
  readonly event: E
  readonly options: FeedOptions
}

/**
 * The committed `event`s of one actor after `after`, as they commit: read
 * from the server's event feed and reopened from the last cursor delivered
 * whenever the connection drops, the server restarts, or the credential
 * expires and is refreshed. It fails with `RetentionGap` if events after the
 * cursor were pruned, and with `UnknownCursor` for a cursor the actor never
 * issued. A dropped or refused feed reopens after the server's `retryAfter`,
 * never sooner, or after a jittered, growing delay. Every event carries its
 * cursor as `id`; the feed's own `end` carries none, so an event named `end` is
 * still an event.
 */
export const feedStream = <E extends EventClass>({
  open,
  event,
  options,
}: FeedSource<E>): Stream.Stream<FeedEntry<E["Type"]>, Failure> =>
  session({
    signal: options.signal,
    run: (emit) => {
      const decodeEvent: (json: Schema.Json) => Effect.Effect<E["Type"], Schema.SchemaError> =
        Schema.decodeUnknownEffect(Schema.toCodecJson(event))

      let last = options.after

      return reconnecting((delivered) =>
        Effect.gen(function* () {
          const response = yield* open(last, yield* Effect.abortSignal)

          yield* readEvents({ response, refused: failureOf, idleMs: IDLE_MS }).pipe(
            Stream.runForEach((message) =>
              Effect.gen(function* () {
                if (message.id === undefined)
                  return message.event === "end" ? yield* failureOf(message.data, 0) : undefined

                const data = yield* decodeData(message.data).pipe(
                  Effect.mapError(undecodableFailure),
                )

                const decoded = yield* decodeEvent(data.event).pipe(
                  Effect.mapError(undecodableFailure),
                )

                last = message.id
                yield* delivered

                yield* emit({
                  cursor: message.id,
                  event: decoded,
                  commandId: data.commandId,
                  timestamp: data.timestamp,
                })
              }),
            ),
          )
        }),
      )
    },
  })
