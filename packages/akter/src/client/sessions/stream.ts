import { Effect, type Option, Schema, Stream } from "effect"
import type { ServedMember } from "../../actor/served.ts"
import type { ValueSchema } from "../../members/command.ts"
import { decodeFailure, type Failure, networkFailure, undecodableFailure } from "../transport.ts"
import { readEvents, session } from "./sse.ts"

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

/** Ends the subscription's read loop after the stream's own successful `end`. */
class Finished {
  readonly _tag = "Finished"
}

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
  session({
    signal: options.signal,
    run: (emit) =>
      Effect.gen(function* () {
        const decodeElement = Schema.decodeUnknownEffect(Schema.toCodecJson(member.output))

        const failureOf = (text: string, status: number) =>
          decodeFailure(declared)({ status, headers: new Headers(), text, sentAt: 0 })

        const response = yield* open(yield* Effect.abortSignal)

        const read = readEvents({ response, refused: failureOf }).pipe(
          Stream.runForEach((message) =>
            Effect.gen(function* () {
              const json = yield* decodeJson(message.data).pipe(Effect.mapError(undecodableFailure))

              if (message.event !== "end")
                return yield* emit(
                  yield* decodeElement(json).pipe(Effect.mapError(undecodableFailure)),
                )

              return yield* json === null
                ? Effect.fail(new Finished())
                : Effect.fail(failureOf(message.data, 0))
            }),
          ),
        )

        const cut = yield* read.pipe(
          Effect.as(true),
          Effect.catchIf(
            (error): error is Finished => error instanceof Finished,
            () => Effect.succeed(false),
          ),
        )

        if (cut) return yield* networkFailure()
      }),
  })
