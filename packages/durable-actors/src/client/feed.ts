import { Duration, Effect, Option, Queue, Random, Schema, Stream } from "effect"
import { ActorError, TransportError, Unauthorized } from "../errors/actor.ts"
import { RetentionGap, UnknownCursor } from "../errors/events.ts"
import type { EventClass } from "../members/event.ts"
import { decodeFailure, type Failure, transport } from "./transport.ts"

/** One committed event a feed delivered, with the cursor to resume after it. */
export interface FeedEntry<E> {
  /** Exclusive resume point: pass it as `after` to read the events that follow. */
  readonly cursor: string
  readonly event: E
  readonly commandId: string
  /** When the event committed, in milliseconds since the epoch. */
  readonly timestamp: number
}

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

const network = () => TransportError.make({ code: "network", retryable: true }).pipe(transport)

const undecodable = () => TransportError.make({ code: "decode", retryable: false }).pipe(transport)

/** A body a feed was refused or ended with, as the failure it names. */
const failureOf = (text: string, status: number) =>
  decodeFailure(cursorError)({ status, headers: new Headers(), text, sentAt: 0 })

export interface Message {
  readonly id: string | undefined
  readonly event: string | undefined
  readonly data: string
}

/** Splits SSE text into complete messages, keeping a partial one for the next chunk. */
export const parse = (buffer: string) => {
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

const isExpired = (failure: Failure) =>
  Schema.is(ActorError)(failure) &&
  Schema.is(Unauthorized)(failure.reason) &&
  failure.reason.code === "expired"

/** Whether a feed that ended with `failure` may reopen from its cursor. */
const reopens = (failure: Failure, authRetried: boolean) =>
  Schema.is(ActorError)(failure) && (failure.isRetryable || (!authRetried && isExpired(failure)))

export interface FeedSource<E extends EventClass> {
  /** Fetches the feed after `cursor`, sent as `Last-Event-ID`, with fresh headers each time. */
  readonly open: (
    cursor: string | undefined,
    signal: AbortSignal,
  ) => Effect.Effect<Response, ActorError>
  readonly event: E
  readonly options: FeedOptions
}

/**
 * The committed `event`s of one actor after `after`, as they commit: read
 * from the server's event feed and reopened from the last cursor delivered
 * whenever the connection drops, the server restarts, or the credential
 * expires and is refreshed. It fails with `RetentionGap` if events after the
 * cursor were pruned, and with `UnknownCursor` for a cursor the actor never
 * issued.
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

      // One request: succeeds when the stream ends or goes idle, fails with how it ended.
      const once = Effect.gen(function* () {
        const response = yield* open(last, yield* Effect.abortSignal)

        if (response.status !== 200) {
          const text = yield* Effect.tryPromise({ try: () => response.text(), catch: network })

          return yield* failureOf(text, response.status)
        }

        if (response.body === null) return yield* undecodable()

        const reader = response.body.getReader()

        yield* Effect.addFinalizer(() =>
          Effect.promise(() => reader.cancel().catch(() => undefined)),
        )

        const text = new TextDecoder()
        let buffer = ""

        while (true) {
          const chunk = yield* Effect.tryPromise({ try: () => reader.read(), catch: network }).pipe(
            Effect.timeoutOption(IDLE_MS),
          )

          if (Option.isNone(chunk) || chunk.value.done) return

          buffer += text.decode(chunk.value.value, { stream: true })
          const parsed = parse(buffer)
          buffer = parsed.rest

          for (const message of parsed.messages) {
            if (message.event === "end") return yield* failureOf(message.data, 0)

            if (message.id === undefined) continue

            const data = yield* decodeData(message.data).pipe(Effect.mapError(undecodable))
            const decoded = yield* decodeEvent(data.event).pipe(Effect.mapError(undecodable))
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

        // A dropped or refused feed reopens after `retryAfter`, or a jittered, growing delay.
        const backoff = Math.min(MAX_BACKOFF_MS, 100 * 2 ** failures)
        failures += 1
        const jitter = yield* Random.nextBetween(0.5, 1.5)

        yield* Effect.sleep(Duration.millis(Math.round((hinted ?? backoff) * jitter)))
      }
    }).pipe(
      Effect.catch((failure) => Queue.fail(out, failure)),
      Effect.andThen(Queue.end(out)),
    ),
  ).pipe(
    Stream.interruptWhen(
      Effect.callback<void>((resume) => {
        const signal = options.signal

        if (signal === undefined) return

        if (signal.aborted) return resume(Effect.void)

        const onAbort = () => resume(Effect.void)
        signal.addEventListener("abort", onAbort, { once: true })

        return Effect.sync(() => signal.removeEventListener("abort", onAbort))
      }),
    ),
  )
