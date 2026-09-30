import { Effect, Option, Queue, Schema, Stream } from "effect"
import type { ServedMember } from "../../actor/served.ts"
import type { ValueSchema } from "../../members/command.ts"
import { readEvents } from "./feed.ts"
import {
  aborted,
  decodeFailure,
  type Failure,
  networkFailure,
  undecodableFailure,
} from "../transport.ts"

/** Options of one stream subscription. */
export interface StreamOptions {
  /** Ends the subscription. */
  readonly signal?: AbortSignal
}

interface StreamSource {
  /** The served stream member subscribed to. */
  readonly member: ServedMember
  /** Posts the subscription with its encoded input and fresh headers. */
  readonly open: (signal: AbortSignal) => Effect.Effect<Response, Failure>
  /** Decodes the member's declared errors from a served body. */
  readonly declared: (body: Schema.Json) => Option.Option<Failure>
  readonly options: StreamOptions
}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

/**
 * One subscription to an `Actor.stream` member: its elements as they arrive,
 * ending when the stream ends by itself and failing with the `ActorError` or
 * declared error that ended it. Streams have no cursor, so a dropped
 * subscription is not resumed: it fails with a retryable `TransportError`,
 * and the caller subscribes again. A stream that closes without an `end`
 * message was cut, not finished.
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

      const { next } = yield* readEvents({
        response: yield* open(yield* Effect.abortSignal),
        refused: failureOf,
      })

      while (true) {
        const messages = yield* next

        if (messages === undefined) return yield* networkFailure()

        for (const message of messages) {
          if (message.event === "end") {
            const body = yield* decodeJson(message.data).pipe(Effect.mapError(undecodableFailure))

            if (body === null) return

            return yield* failureOf(message.data, 0)
          }

          const json = yield* decodeJson(message.data).pipe(Effect.mapError(undecodableFailure))
          yield* Queue.offer(
            out,
            yield* decodeElement(json).pipe(Effect.mapError(undecodableFailure)),
          )
        }
      }
    }).pipe(
      Effect.scoped,
      Effect.catch((failure) => Queue.fail(out, failure)),
      Effect.andThen(Queue.end(out)),
    ),
  ).pipe(Stream.interruptWhen(aborted(options.signal)))
