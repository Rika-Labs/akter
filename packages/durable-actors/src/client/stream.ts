import { Effect, Option, Queue, Schema, Stream } from "effect"
import type { ServedMember } from "../actor/served.ts"
import type { ValueSchema } from "../members/command.ts"
import { TransportError } from "../errors/actor.ts"
import { parse } from "./feed.ts"
import { decodeFailure, type Failure, transport } from "./transport.ts"

export interface StreamOptions {
  /** Ends the subscription. */
  readonly signal?: AbortSignal
}

export interface StreamSource {
  readonly member: ServedMember
  /** Posts the subscription with its encoded input and fresh headers. */
  readonly open: (signal: AbortSignal) => Effect.Effect<Response, Failure>
  readonly declared: (body: Schema.Json) => Option.Option<Failure>
  readonly options: StreamOptions
}

const network = () => TransportError.make({ code: "network", retryable: true }).pipe(transport)

const undecodable = () => TransportError.make({ code: "decode", retryable: false }).pipe(transport)

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

/**
 * One subscription to an `Actor.stream` member: its elements as they arrive,
 * ending when the stream ends by itself and failing with the `ActorError` or
 * declared error that ended it. Streams have no cursor, so a dropped
 * subscription is not resumed: it fails with a retryable `TransportError`,
 * and the caller subscribes again.
 */
export const subscription = ({
  member,
  open,
  declared,
  options,
}: StreamSource): Stream.Stream<ValueSchema["Type"], Failure> =>
  Stream.callback<ValueSchema["Type"], Failure>((out) =>
    Effect.gen(function* () {
      const decodeElement = Schema.decodeUnknownEffect(Schema.toCodecJson(member.output))

      const failureOf = (text: string, status: number) =>
        decodeFailure(declared)({ status, headers: new Headers(), text, sentAt: 0 })

      const response = yield* open(yield* Effect.abortSignal)

      if (response.status !== 200) {
        const text = yield* Effect.tryPromise({ try: () => response.text(), catch: network })

        return yield* failureOf(text, response.status)
      }

      if (response.body === null) return yield* undecodable()

      const reader = response.body.getReader()

      yield* Effect.addFinalizer(() => Effect.promise(() => reader.cancel().catch(() => undefined)))

      const text = new TextDecoder()
      let buffer = ""

      while (true) {
        const chunk = yield* Effect.tryPromise({ try: () => reader.read(), catch: network })

        // A stream that closes without `end` was cut, not finished.
        if (chunk.done) return yield* network()

        buffer += text.decode(chunk.value, { stream: true })
        const parsed = parse(buffer)
        buffer = parsed.rest

        for (const message of parsed.messages) {
          if (message.event === "end") {
            const body = yield* decodeJson(message.data).pipe(Effect.mapError(undecodable))

            if (body === null) return

            return yield* failureOf(message.data, 0)
          }

          const json = yield* decodeJson(message.data).pipe(Effect.mapError(undecodable))
          yield* Queue.offer(out, yield* decodeElement(json).pipe(Effect.mapError(undecodable)))
        }
      }
    }).pipe(
      Effect.scoped,
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
