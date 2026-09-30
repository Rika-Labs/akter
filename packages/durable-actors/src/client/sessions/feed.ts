import { Duration, Effect, Option, Queue, Random, Schema, Stream } from "effect"
import { ActorError, Unauthorized } from "../../errors/actor.ts"
import { RetentionGap, UnknownCursor } from "../../errors/events.ts"
import type { EventClass } from "../../members/event.ts"
import {
  aborted,
  decodeFailure,
  type Failure,
  networkFailure,
  undecodableFailure,
} from "../transport.ts"

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

/** No bytes for this long, keepalive comments included, means the stream is dead. */
const IDLE_MS = 45_000

const MAX_BACKOFF_MS = 5_000

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

/** One SSE message: its `id` and `event` fields when it has them, and its joined `data` lines. */
interface Message {
  readonly id: string | undefined
  readonly event: string | undefined
  readonly data: string
}

/** Splits SSE text into complete messages, keeping a partial one for the next chunk. */
const parse = (buffer: string) => {
  const blocks = buffer.replace(/\r\n?/g, "\n").split("\n\n")
  const rest = blocks.pop() ?? ""
  const messages: Array<Message> = []

  for (const block of blocks) {
    const fields = new Map<string, string>()
    const data: Array<string> = []

    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue

      const colon = line.indexOf(":")
      const name = colon === -1 ? line : line.slice(0, colon)
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "")

      if (name === "data") data.push(value)
      else fields.set(name, value)
    }

    if (data.length > 0)
      messages.push({ id: fields.get("id"), event: fields.get("event"), data: data.join("\n") })
  }

  return { messages, rest }
}

/**
 * Reads a `200` SSE response: `next` yields the messages each chunk
 * completes, or `undefined` once the body closes or, with `idleMs`, sends no
 * bytes for that long. Any other status fails with `refused` of its body. The
 * body's reader is cancelled when the scope closes.
 */
export const readEvents = ({
  response,
  refused,
  idleMs,
}: {
  readonly response: Response
  readonly refused: (text: string, status: number, headers: Headers) => Failure
  readonly idleMs?: number
}) =>
  Effect.gen(function* () {
    if (response.status !== 200) {
      const text = yield* Effect.tryPromise({ try: () => response.text(), catch: networkFailure })

      return yield* refused(text, response.status, response.headers)
    }

    if (response.body === null) return yield* undecodableFailure()

    const reader = response.body.getReader()

    yield* Effect.addFinalizer(() => Effect.promise(() => reader.cancel().catch(() => undefined)))

    const read = Effect.tryPromise({ try: () => reader.read(), catch: networkFailure })
    const text = new TextDecoder()
    let buffer = ""

    const next = (
      idleMs === undefined ? Effect.asSome(read) : read.pipe(Effect.timeoutOption(idleMs))
    ).pipe(
      Effect.map((chunk): ReadonlyArray<Message> | undefined => {
        if (Option.isNone(chunk) || chunk.value.done) return undefined

        buffer += text.decode(chunk.value.value, { stream: true })
        const parsed = parse(buffer)
        buffer = parsed.rest

        return parsed.messages
      }),
    )

    return { next }
  })

const isExpired = (failure: Failure) =>
  Schema.is(ActorError)(failure) &&
  Schema.is(Unauthorized)(failure.reason) &&
  failure.reason.code === "expired"

/** Whether a feed that ended with `failure` may reopen from its cursor. */
const reopens = (failure: Failure, authRetried: boolean) =>
  Schema.is(ActorError)(failure) && (failure.isRetryable || (!authRetried && isExpired(failure)))

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
  Stream.callback<FeedEntry<E["Type"]>, Failure>((out) =>
    Effect.gen(function* () {
      const decodeEvent: (json: Schema.Json) => Effect.Effect<E["Type"], Schema.SchemaError> =
        Schema.decodeUnknownEffect(Schema.toCodecJson(event))

      let last = options.after
      let failures = 0
      let authRetried = false

      const once = Effect.gen(function* () {
        const { next } = yield* readEvents({
          response: yield* open(last, yield* Effect.abortSignal),
          refused: failureOf,
          idleMs: IDLE_MS,
        })

        while (true) {
          const messages = yield* next

          if (messages === undefined) return

          for (const message of messages) {
            if (message.id === undefined) {
              if (message.event === "end") return yield* failureOf(message.data, 0)

              continue
            }

            const data = yield* decodeData(message.data).pipe(Effect.mapError(undecodableFailure))
            const decoded = yield* decodeEvent(data.event).pipe(Effect.mapError(undecodableFailure))
            last = message.id
            failures = 0
            authRetried = false

            yield* Queue.offer(out, {
              cursor: message.id,
              event: decoded,
              commandId: data.commandId,
              timestamp: data.timestamp,
            })
          }
        }
      }).pipe(Effect.scoped)

      while (true) {
        const ended = yield* once.pipe(Effect.flip, Effect.option)
        let hinted: number | undefined = undefined

        if (Option.isSome(ended)) {
          if (!reopens(ended.value, authRetried)) return yield* ended.value

          if (isExpired(ended.value)) authRetried = true

          if (Schema.is(ActorError)(ended.value))
            hinted = Option.getOrUndefined(ended.value.retryAfter)
        }

        const backoff = Math.min(MAX_BACKOFF_MS, 100 * 2 ** failures)
        failures += 1
        const jitter = yield* Random.nextBetween(0.5, 1.5)

        yield* Effect.sleep(Duration.millis(hinted ?? Math.round(backoff * jitter)))
      }
    }).pipe(
      Effect.catch((failure) => Queue.fail(out, failure)),
      Effect.andThen(Queue.end(out)),
    ),
  ).pipe(Stream.interruptWhen(aborted(options.signal)))
