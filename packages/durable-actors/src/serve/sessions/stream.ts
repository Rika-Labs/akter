import { Effect, Schema, Stream } from "effect"
import { ActorError } from "../../errors/actor.ts"
import { FEED_KEEPALIVE_MS } from "./feed.ts"
import { actorErrorBody } from "../wire.ts"

const decodeElement = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ value: Schema.optionalKey(Schema.Json) })),
)

const decodeDeclared = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const end = (body: Schema.Json) =>
  encodeJson(body).pipe(
    Effect.orDie,
    Effect.map((data) => `event: end\ndata: ${data}\n\n`),
  )

/**
 * A subscription as SSE text: each element as `event: element` with its
 * encoded value as `data`, then one `end` message: `null` when the stream
 * ended by itself, else the `ActorError` envelope or the member's declared
 * error that ended it. Streams have no cursor, so there is no `id`. A comment
 * line is sent every `FEED_KEEPALIVE_MS` so idle proxies don't close a quiet
 * stream.
 */
export const streamResponse = (
  elements: Stream.Stream<string, ActorError | { readonly failure: string }>,
) =>
  elements.pipe(
    Stream.mapEffect((element) =>
      decodeElement(element).pipe(
        Effect.orDie,
        Effect.flatMap(({ value }) => encodeJson(value ?? null).pipe(Effect.orDie)),
        Effect.map((data) => `event: element\ndata: ${data}\n\n`),
      ),
    ),
    Stream.concat(Stream.fromEffect(end(null))),
    Stream.catch((error) =>
      Stream.fromEffect(
        Schema.is(ActorError)(error)
          ? actorErrorBody(error).pipe(Effect.flatMap(end))
          : decodeDeclared(error.failure).pipe(Effect.orDie, Effect.flatMap(end)),
      ),
    ),
    Stream.merge(
      Stream.tick(FEED_KEEPALIVE_MS).pipe(
        Stream.drop(1),
        Stream.map(() => ": keepalive\n\n"),
      ),
      { haltStrategy: "left" },
    ),
    Stream.encodeText,
  )
