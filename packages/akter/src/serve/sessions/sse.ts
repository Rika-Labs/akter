import { Effect, Schema, Stream } from "effect"
import { Sse } from "effect/encoding"
import { ActorError } from "../../errors/actor.ts"
import { actorErrorBody } from "../../protocol/wire.ts"

/** A comment line this often keeps idle proxies from closing a quiet response. */
export const KEEPALIVE_MS = 15_000

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json))

const decodeValue = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ value: Schema.optionalKey(Schema.Json) })),
)

/**
 * One SSE message: `event` and JSON `data`, and `id` when the protocol gives
 * the message a position. A message without `id` writes no `id` line, so a
 * standard reader sees it inherit the previous one.
 */
export const message = ({
  event,
  data,
  id,
}: {
  readonly event: string
  readonly data: Schema.Json
  readonly id?: string | undefined
}) =>
  encodeJson(data).pipe(
    Effect.orDie,
    Effect.map((text) => Sse.encoder.write(Sse.Event.make({ id, event, data: text }))),
  )

/** The JSON of an encoded member output, as a live runtime frame carries it: `null` for none. */
export const valueJson = (encoded: string) =>
  decodeValue(encoded).pipe(
    Effect.orDie,
    Effect.map(({ value }) => value ?? null),
  )

/** What ended a live session: an `ActorError`, or a declared failure in its encoded form. */
export type SessionFailure = ActorError | { readonly failure: string }

/** The body a session's `end` carries for `error`, as a served response would. */
export const failureJson = (error: SessionFailure): Effect.Effect<Schema.Json> =>
  Schema.is(ActorError)(error)
    ? actorErrorBody(error)
    : decodeJson(error.failure).pipe(Effect.orDie)

/**
 * SSE text as bytes, with a `: keepalive` comment every `KEEPALIVE_MS` while
 * `messages` is open; the response ends when `messages` does.
 */
export const withKeepalive = <E>(messages: Stream.Stream<string, E>) =>
  messages.pipe(
    Stream.merge(
      Stream.tick(KEEPALIVE_MS).pipe(
        Stream.drop(1),
        Stream.map(() => ": keepalive\n\n"),
      ),
      { haltStrategy: "left" },
    ),
    Stream.encodeText,
  )
