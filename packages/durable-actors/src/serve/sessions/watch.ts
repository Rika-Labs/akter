import { Effect, Schema, Stream } from "effect"
import { ActorError } from "../../errors/actor.ts"
import type { WatchResult } from "../../handles/actors.ts"
import { actorErrorBody } from "../wire.ts"
import { FEED_KEEPALIVE_MS } from "./feed.ts"

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
 * A watch as SSE text: each result as `event: result` with the encoded output
 * as `data`, and as `id` the commit version its rerun waited for when there was
 * one. A watch is state, not history, so there is no `Last-Event-ID` resume: a
 * reconnect opens a new watch whose first result is the current state. The last
 * message is `end`, carrying the `ActorError` envelope or the query's declared
 * error that ended it.
 */
export const watchResponse = (
  results: Stream.Stream<WatchResult, ActorError | { readonly failure: string }>,
) =>
  results.pipe(
    Stream.mapEffect(({ version, value }) =>
      decodeElement(value).pipe(
        Effect.orDie,
        Effect.flatMap((decoded) => encodeJson(decoded.value ?? null).pipe(Effect.orDie)),
        Effect.map(
          (data) =>
            `${version === undefined ? "" : `id: ${version}\n`}event: result\ndata: ${data}\n\n`,
        ),
      ),
    ),
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
